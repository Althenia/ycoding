#![allow(dead_code)]

use std::{
    io::BufRead,
    path::Path,
    process::{Child, Command, Stdio},
};

pub fn source_fixture(file: &Path, mode: &str, project: &str, extra_sql: &str) -> Child {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let script = r#"
import sqlite3,sys,re
db=sqlite3.connect(sys.argv[1])
schema=open(sys.argv[2]).read()
for sql in re.findall(r'`((?:\\.|[^`])*)`',schema): db.executescript(sql.replace('\\`','`'))
db.executescript("CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);CREATE TABLE database_format(id TEXT PRIMARY KEY,time_created INTEGER NOT NULL);INSERT INTO database_format VALUES('current-2026-08-04',0);INSERT INTO migration VALUES('20261010015127_telemetry-consent',1);")
db.commit()
if sys.argv[3]!='rollback': db.execute('PRAGMA journal_mode=WAL')
if sys.argv[3]=='wal': db.execute('PRAGMA wal_autocheckpoint=0')
db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES(?,'/synthetic',1,2,'[]')",(sys.argv[4],))
db.executescript(sys.argv[5])
db.commit()
if sys.argv[3]=='plain': db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
print('ready',flush=True)
sys.stdin.read()
db.close()
"#;
    let mut child = Command::new("python3")
        .args(["-c", script])
        .arg(file)
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/core/src/database/schema.gen.ts"
        ))
        .arg(mode)
        .arg(project)
        .arg(extra_sql)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "ready");
    child
}

pub fn meeting_source(stable: &Path, wal: bool) {
    let baseline = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../extensions/meeting/test/fixture/stable-meeting")
        .join(if wal { "wal" } else { "checkpointed" });
    std::fs::create_dir_all(stable).unwrap();
    for name in [
        "meetings.sqlite",
        "meetings.sqlite-wal",
        "meetings.sqlite-shm",
    ] {
        if wal || name == "meetings.sqlite" {
            std::fs::copy(baseline.join(name), stable.join(name)).unwrap();
        }
    }
    if !wal {
        assert!(Command::new("python3").args(["-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('PRAGMA journal_mode=WAL');db.close()"])
            .arg(stable.join("meetings.sqlite")).status().unwrap().success());
    }
}
