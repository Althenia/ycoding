use std::process::ExitCode;
use ycoding_runtime::launch::{
    EXIT_FAILURE, EXIT_OK, EXIT_USAGE, LaunchError, Mode, Parsed, USAGE, parse_launch,
    record_startup_error, run_inherited,
};

mod resources_stdio;

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--ycoding-internal-resources-v1"] {
        return ExitCode::from(if resources_stdio::run().is_ok() {
            EXIT_OK
        } else {
            EXIT_FAILURE
        });
    }
    if let Some(result) = ycoding_runtime::regex_worker::run(&args) {
        return match result {
            Ok(code) => ExitCode::from(code),
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(EXIT_FAILURE)
            }
        };
    }
    let (args, data, cleanup) = match parent_descriptors(args) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let parsed = match parse_launch(&args, |name| std::env::var(name).ok()) {
        Ok(parsed) => parsed,
        Err(error @ LaunchError::Usage(_)) => {
            eprintln!("{error}\n\n{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(EXIT_FAILURE);
        }
    };
    match parsed {
        Parsed::Help => {
            print!("{USAGE}");
            ExitCode::from(EXIT_OK)
        }
        Parsed::Version(version) => {
            println!("ycoding-runtime {version}");
            ExitCode::from(EXIT_OK)
        }
        Parsed::Run(config) => {
            if config.mode == Mode::Stdio {
                unsafe {
                    std::env::remove_var("YCODING_PASSWORD");
                    std::env::remove_var("YCODING_SERVER_PASSWORD");
                }
            }
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    record_startup_error(&config, &LaunchError::Io(error));
                    eprintln!("failed to create the runtime");
                    return ExitCode::from(EXIT_FAILURE);
                }
            };
            match run_inherited((*config).clone(), &runtime, data, cleanup) {
                Ok(()) => ExitCode::from(EXIT_OK),
                Err(error) => {
                    record_startup_error(&config, &error);
                    eprintln!("{error}");
                    ExitCode::from(EXIT_FAILURE)
                }
            }
        }
        Parsed::Paths(paths) => {
            println!("{paths}");
            ExitCode::from(EXIT_OK)
        }
    }
}

type ParentDescriptors = (Vec<String>, Option<u32>, Option<u32>);

fn parent_descriptors(args: Vec<String>) -> Result<ParentDescriptors, LaunchError> {
    let mut retained = Vec::with_capacity(args.len());
    let mut data = None;
    let mut cleanup = None;
    let mut arguments = args.into_iter();
    while let Some(argument) = arguments.next() {
        let (flag, inline) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(flag, value)| {
                (flag, Some(value))
            });
        let descriptor = match flag {
            "--plugin-parent-fd" => &mut data,
            "--plugin-parent-cleanup-fd" => &mut cleanup,
            _ => {
                retained.push(argument);
                continue;
            }
        };
        let invalid = || LaunchError::Usage("invalid parent plugin descriptor arguments".into());
        if descriptor.is_some() {
            return Err(invalid());
        }
        let value = match inline {
            Some(value) => value.to_owned(),
            None => arguments.next().ok_or_else(invalid)?,
        };
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        *descriptor = Some(value.parse::<u32>().map_err(|_| invalid())?);
    }
    if data.is_some() != cleanup.is_some() {
        return Err(LaunchError::Usage(
            "parent plugin descriptors require both explicit arguments".into(),
        ));
    }
    Ok((retained, data, cleanup))
}

#[cfg(test)]
mod tests {
    use super::parent_descriptors;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn ordinary_arguments_do_not_select_an_attachment() {
        let original = args(&["serve", "--stdio", "--port", "0"]);
        let (retained, data, cleanup) = parent_descriptors(original.clone()).unwrap();
        assert_eq!(retained, original);
        assert_eq!((data, cleanup), (None, None));
    }

    #[test]
    fn only_explicit_descriptor_arguments_are_removed() {
        let (retained, data, cleanup) = parent_descriptors(args(&[
            "--plugin-parent-fd",
            "3",
            "--stdio",
            "--plugin-parent-cleanup-fd=4",
            "--port",
            "0",
        ]))
        .unwrap();
        assert_eq!(retained, args(&["--stdio", "--port", "0"]));
        assert_eq!((data, cleanup), (Some(3), Some(4)));
    }

    #[test]
    fn malformed_or_partial_descriptors_fail_without_falling_through() {
        for values in [
            vec!["--plugin-parent-fd"],
            vec!["--plugin-parent-fd", "3"],
            vec!["--plugin-parent-cleanup-fd", "4"],
            vec![
                "--plugin-parent-fd",
                "-1",
                "--plugin-parent-cleanup-fd",
                "4",
            ],
            vec![
                "--plugin-parent-fd",
                "+3",
                "--plugin-parent-cleanup-fd",
                "4",
            ],
            vec!["--plugin-parent-fd=", "--plugin-parent-cleanup-fd", "4"],
            vec![
                "--plugin-parent-fd",
                "4294967296",
                "--plugin-parent-cleanup-fd",
                "4",
            ],
            vec![
                "--plugin-parent-fd",
                "3",
                "--plugin-parent-fd",
                "5",
                "--plugin-parent-cleanup-fd",
                "4",
            ],
        ] {
            assert!(parent_descriptors(args(&values)).is_err());
        }
    }
}
