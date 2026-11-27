use super::error::Error;
use ring::digest::{Context, SHA256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const MODEL_ID: &str = "BAAI/bge-small-en-v1.5";
pub const DIMENSIONS: usize = 384;
const HOST: &str = "https://huggingface.co";

#[derive(Clone, Copy, Debug)]
pub struct Artifact {
    pub name: &'static str,
    pub remote: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Pin {
    pub repository: &'static str,
    pub revision: &'static str,
    pub artifacts: &'static [Artifact],
}

pub const BGE_SMALL: Pin = Pin {
    repository: "Xenova/bge-small-en-v1.5",
    revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
    artifacts: &[
        Artifact {
            name: "model.onnx",
            remote: "onnx/model.onnx",
            sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
            size: 133_093_490,
        },
        Artifact {
            name: "tokenizer.json",
            remote: "tokenizer.json",
            sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
            size: 711_396,
        },
        Artifact {
            name: "config.json",
            remote: "config.json",
            sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
            size: 683,
        },
        Artifact {
            name: "special_tokens_map.json",
            remote: "special_tokens_map.json",
            sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
            size: 125,
        },
        Artifact {
            name: "tokenizer_config.json",
            remote: "tokenizer_config.json",
            sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
            size: 366,
        },
    ],
};

pub fn directory(root: &Path, pin: &Pin) -> PathBuf {
    root.join("bge-small-en-v1.5").join(pin.revision)
}

fn verified_marker(dir: &Path) -> PathBuf {
    dir.join(".verified")
}

pub fn is_provisioned(dir: &Path, pin: &Pin) -> bool {
    verified_marker(dir).is_file()
        && pin
            .artifacts
            .iter()
            .all(|a| fs::metadata(dir.join(a.name)).is_ok_and(|m| m.len() == a.size))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn provision(root: &Path, pin: &Pin, base: Option<&str>) -> Result<PathBuf, Error> {
    let dir = directory(root, pin);
    if is_provisioned(&dir, pin) {
        return Ok(dir);
    }
    let fail = |e: &dyn std::fmt::Display| Error::Provision(e.to_string());
    fs::create_dir_all(&dir).map_err(|e| fail(&e))?;
    let client = reqwest::Client::builder().build().map_err(|e| fail(&e))?;
    let base = base.unwrap_or(HOST);
    for artifact in pin.artifacts {
        let target = dir.join(artifact.name);
        if fs::metadata(&target).is_ok_and(|m| m.len() == artifact.size)
            && hash_file(&target).is_ok_and(|h| h == artifact.sha256)
        {
            continue;
        }
        let url = format!(
            "{base}/{}/resolve/{}/{}",
            pin.repository, pin.revision, artifact.remote
        );
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| fail(&e))?;
        let part = dir.join(format!("{}.part", artifact.name));
        let mut file = fs::File::create(&part).map_err(|e| fail(&e))?;
        let mut context = Context::new(&SHA256);
        let mut written = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|e| fail(&e))? {
            written += chunk.len() as u64;
            if written > artifact.size {
                let _ = fs::remove_file(&part);
                return Err(Error::Provision(format!(
                    "{} exceeds its pinned size",
                    artifact.name
                )));
            }
            context.update(&chunk);
            file.write_all(&chunk).map_err(|e| fail(&e))?;
        }
        file.sync_all().map_err(|e| fail(&e))?;
        if written != artifact.size || hex(context.finish().as_ref()) != artifact.sha256 {
            let _ = fs::remove_file(&part);
            return Err(Error::Provision(format!(
                "{} failed integrity verification",
                artifact.name
            )));
        }
        fs::rename(&part, &target).map_err(|e| fail(&e))?;
    }
    fs::write(verified_marker(&dir), pin.revision).map_err(|e| fail(&e))?;
    Ok(dir)
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            return Ok(hex(context.finish().as_ref()));
        }
        context.update(&buffer[..n]);
    }
}
