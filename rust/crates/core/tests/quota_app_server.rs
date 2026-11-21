use ycoding_core::resources::model::quota::{AppServerCommand, Error, load_app_server};
use ycoding_schema::provider;

fn command(script: &str) -> AppServerCommand {
    AppServerCommand {
        command: "bun".into(),
        args: vec!["-e".into(), script.into()],
        timeout_ms: Some(1000.0),
        cwd: None,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn close_closes_stdin_sends_term_and_never_escalates_to_kill() {
    let root = std::env::temp_dir().join(format!("ycoding-codex-close-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let marker = root.join("events");
    let script = format!(
        r#"const fs=require('fs');const marker={};fs.writeFileSync(marker,String(process.pid));process.on('SIGTERM',()=>fs.appendFileSync(marker,' TERM'));let b='';for await(const c of Bun.stdin.stream()){{b+=new TextDecoder().decode(c);while(b.includes('\n')){{let n=b.indexOf('\n');let q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.id!==undefined)console.log(JSON.stringify({{id:q.id,result:q.method==='initialize'?{{}}:{{primary:{{usedPercent:0}}}}}}));}}}}fs.appendFileSync(marker,' EOF');await new Promise(()=>setInterval(()=>{{}},1000));"#,
        serde_json::to_string(marker.to_str().unwrap()).unwrap()
    );
    let result = load_app_server(
        &command(&script),
        provider::Id("openai".into()),
        "Codex",
        100,
    )
    .await;
    let events = std::fs::read_to_string(&marker).unwrap();
    let pid = events
        .split_whitespace()
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let alive = ycoding_core::platform::process::is_alive(pid).unwrap();
    if alive {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while ycoding_core::platform::process::is_alive(pid).unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_dir_all(root).unwrap();
    result.unwrap();
    assert!(alive, "TERM-resistant app server was force killed");
    assert!(events.contains("EOF"), "stdin remained open: {events}");
    assert!(events.contains("TERM"), "TERM was not delivered: {events}");
}

#[tokio::test]
async fn app_server_uses_official_sequence_ignores_unrelated_lines_and_closes() {
    let script = r#"let buffer='';let step=0;for await(const chunk of Bun.stdin.stream()){buffer+=new TextDecoder().decode(chunk);while(buffer.includes('\n')){const at=buffer.indexOf('\n');const line=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(step===0){if(line.method!=='initialize'||line.id!==0||JSON.stringify(line.params)!==JSON.stringify({clientInfo:{name:'ycoding',title:'YCoding',version:'1'}}))process.exit(10);console.log('not-json');console.log(JSON.stringify({id:99,result:{}}));console.log(JSON.stringify({id:0,result:{userAgent:'fixture'}}));}if(step===1&&JSON.stringify(line)!==JSON.stringify({method:'initialized'}))process.exit(11);if(step===2){if(line.method!=='account/rateLimits/read'||line.id!==1)process.exit(12);console.log(JSON.stringify({id:1,result:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1790000000}}}}));}step++;}}"#;
    let result = load_app_server(
        &command(script),
        provider::Id("openai".into()),
        "Codex",
        100,
    )
    .await
    .unwrap();
    assert_eq!(result.source, "local_client_rpc".into());
    assert_eq!(result.stability, "client_contract".into());
    assert_eq!(result.windows[0].used, Some(25.0));
}

#[tokio::test]
async fn app_server_rpc_errors_exits_timeout_and_buffer_limit_are_typed() {
    let rpc = command(
        r#"for await(const c of Bun.stdin.stream()){console.log(JSON.stringify({id:0,error:{message:'fixture-private'}}));}"#,
    );
    assert_eq!(
        load_app_server(&rpc, provider::Id("openai".into()), "Codex", 100)
            .await
            .unwrap_err(),
        Error::Rpc
    );
    assert_eq!(
        load_app_server(
            &command("process.exit(3)"),
            provider::Id("openai".into()),
            "Codex",
            100
        )
        .await
        .unwrap_err(),
        Error::Rpc
    );
    let mut timeout = command("await Bun.stdin.text();");
    timeout.timeout_ms = Some(1.0);
    assert_eq!(
        load_app_server(&timeout, provider::Id("openai".into()), "Codex", 100)
            .await
            .unwrap_err(),
        Error::Timeout
    );
    assert_eq!(
        load_app_server(
            &command("process.stdout.write('x'.repeat(1048577));await Bun.stdin.text();"),
            provider::Id("openai".into()),
            "Codex",
            100
        )
        .await
        .unwrap_err(),
        Error::BufferLimit
    );
}

#[tokio::test]
async fn configuration_composes_read_only_app_server_snapshot_into_available_provider_list() {
    use ycoding_core::resources::{
        config::{Configuration, LoadOptions, Roots},
        credential,
        model::quota::{Endpoints, Service},
    };
    use ycoding_schema::{DomainEncode, JsonObject, JsonValue};
    let root = std::env::temp_dir().join(format!("ycoding-quota-config-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let script = r#"let b='';for await(const c of Bun.stdin.stream()){b+=new TextDecoder().decode(c);while(b.includes('\n')){let n=b.indexOf('\n');let q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.id!==undefined)console.log(JSON.stringify({id:q.id,result:q.method==='initialize'?{}:{primary:{usedPercent:0}}}));}}"#;
    let mut command = JsonObject::new();
    command.insert("command".into(), "bun".encode());
    command.insert(
        "args".into(),
        JsonValue::Array(vec!["-e".encode(), script.encode()]),
    );
    let mut usage = JsonObject::new();
    usage.insert("codex_app_server".into(), command.encode());
    let mut document = JsonObject::new();
    document.insert("provider_usage".into(), usage.encode());
    let config = Configuration::load(LoadOptions {
        directory: root.clone(),
        roots: Roots::development(&root).unwrap(),
        project: false,
        file: None,
        content: Some(ycoding_schema::stringify_json(&document.encode())),
        env: std::collections::BTreeMap::new(),
    })
    .unwrap();
    assert!(config.diagnostics.is_empty());
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([13; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let service = Service::new(credentials.clone(), Endpoints::default())
        .unwrap()
        .with_configuration(&config)
        .unwrap();
    let snapshots = service
        .list(&[provider::Id("openai".into())], false, 100)
        .await;
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots[1].profile, Some("Codex app-server".into()));
    assert_eq!(snapshots[1].windows[0].used, Some(0.0));
    assert!(service.auxiliary_errors().unwrap().is_empty());
    assert!(credentials.all().unwrap().is_empty());
    service.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
