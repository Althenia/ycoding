use serde_json::json;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use ycoding_core::resources::mcp::client::{Connection, Hooks};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/mcp-verification/wp010a3-resumed");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(format!(
            "elicitation-{}-{}.mjs",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path,r#"import readline from 'node:readline';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
let pending;
for await(const line of readline.createInterface({input:process.stdin})) {
 const msg=JSON.parse(line);
 if(msg.method==='initialize')send(msg.id,{protocolVersion:'2025-11-25',serverInfo:{name:'elicitation',version:'1'},capabilities:{tools:{}}});
 if(msg.method==='tools/list')send(msg.id,{tools:[{name:'ask',inputSchema:{type:'object'}}]});
 if(msg.method==='tools/call') {
  pending=msg.id;
  const params=msg.params.arguments.mode==='url'?{mode:'url',message:'Authorize',url:'https://example.test/authorize',elicitationId:'fixture-elicitation'}:{mode:'form',message:'No fields',requestedSchema:{type:'object',properties:{}}};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'client-input',method:'elicitation/create',params})+'\n');
 }
 if(msg.id==='client-input'&&msg.result)send(pending,{content:[],structuredContent:msg.result});
}"#).unwrap();
        Self(path)
    }
    async fn connect(&self, calls: Arc<AtomicUsize>) -> Connection {
        let config = ServerConfig::decode(
            &parse_json(&json!({"type":"local","command":["bun",self.0]}).to_string()).unwrap(),
        )
        .unwrap();
        Connection::connect(
            "elicitation",
            &config,
            self.0.parent().unwrap(),
            "1",
            &BTreeMap::new(),
            Hooks {
                elicitation: Some(Arc::new(move |_, _, _| {
                    let calls = calls.clone();
                    Box::pin(async move {
                        calls.fetch_add(1, Ordering::Relaxed);
                        Ok(json!({"action":"accept","content":{"internal":"host-only"}}))
                    })
                })),
                ..Hooks::default()
            },
        )
        .await
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).unwrap();
    }
}

#[tokio::test]
async fn empty_form_is_accepted_without_invoking_the_host_form_handler() {
    let fixture = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let connection = fixture.connect(calls.clone()).await;
    connection.tools().await.unwrap();
    let result = connection
        .call_tool("ask", json!({"mode":"form"}), None)
        .await
        .unwrap();
    assert_eq!(
        result.structured,
        Some(json!({"action":"accept","content":{}}))
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    connection.close().await.unwrap();
}

#[tokio::test]
async fn url_acknowledgement_does_not_return_internal_host_content() {
    let fixture = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let connection = fixture.connect(calls.clone()).await;
    connection.tools().await.unwrap();
    let result = connection
        .call_tool("ask", json!({"mode":"url"}), None)
        .await
        .unwrap();
    assert_eq!(result.structured, Some(json!({"action":"accept"})));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    connection.close().await.unwrap();
}
