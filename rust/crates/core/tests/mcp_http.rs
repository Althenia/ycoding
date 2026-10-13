use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use ycoding_core::resources::mcp::client::{Connection, Error, Hooks};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, mcp_skill::Reason, parse_json};

struct Server {
    url: String,
    state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct State {
    requests: Vec<(String, String, Value)>,
    sse: bool,
    unsupported: bool,
    duplicate: bool,
    wrong_skill: bool,
    corrupt: bool,
    unicode_output: bool,
}

impl Server {
    async fn new(sse: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            sse,
            ..State::default()
        }));
        let observed = state.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming=listener.accept()=>{let (mut stream,_)=incoming.unwrap();let state=observed.clone();connections.spawn(async move {
                        let mut request=Vec::new();let mut buffer=[0;2048];
                        let headers_end=loop {let length=stream.read(&mut buffer).await.unwrap();if length==0 {return}request.extend_from_slice(&buffer[..length]);if let Some(offset)=request.windows(4).position(|window|window==b"\r\n\r\n") {break offset+4}};
                        let headers=String::from_utf8(request[..headers_end].to_vec()).unwrap();
                        let method=headers.split_whitespace().next().unwrap();
                        let length=headers.lines().find_map(|line|line.split_once(':').filter(|(key,_)|key.eq_ignore_ascii_case("content-length")).map(|(_,value)|value.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        while request.len()<headers_end+length {let length=stream.read(&mut buffer).await.unwrap();if length==0{return}request.extend_from_slice(&buffer[..length]);}
                        let body=if length==0{Value::Null}else{serde_json::from_slice(&request[headers_end..headers_end+length]).unwrap()};
                        let (status,content_type,response)={
                        let mut state=state.lock().unwrap();state.requests.push((method.into(),headers.clone(),body.clone()));
                        if method!="POST" {(405,"application/json",String::new())}else if body.get("id").is_none(){(202,"application/json",String::new())}else{
                            let params=&body["params"];
                            let result=match body["method"].as_str().unwrap() {
                                "initialize"=>Ok(json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"loopback","version":"1"},"capabilities":{"tools":{"listChanged":true},"prompts":{},"resources":{"listChanged":true},"extensions":{"io.modelcontextprotocol/skills":{"directoryRead":true}}},"instructions":"  Use loopback tools.  "})),
                                "tools/list"=>Ok(if state.duplicate || params.get("cursor").is_none(){let mut value=json!({"tools":[{"name":"first","inputSchema":{"type":"object"},"outputSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}],"nextCursor":"second"});if state.unicode_output {value["tools"][0]["outputSchema"]["properties"]["value"]["minLength"]=json!(2);}value}else{json!({"tools":[{"name":"second","inputSchema":{"type":"object"},"outputSchema":{"type":"object","properties":{"value":{"type":"number"}},"required":["value"]}}]})}),
                                "tools/call"=>Ok(json!({"content":[],"structuredContent":{"value":if state.unicode_output {json!("💡")}else if params["name"]=="first"{json!(42)}else{json!(1)}}})),
                                "prompts/list"=>Ok(json!({"prompts":[{"name":"hello","arguments":[{"name":"person","required":true}]}]})),
                                "prompts/get"=>Ok(json!({"messages":[{"role":"user","content":{"type":"text","text":"Hello"}}]})),
                                "resources/list" if state.unsupported=>Err(-32601),
                                "resources/list"=>Ok(json!({"resources":[{"name":"readme","uri":"test://readme"}]})),
                                "resources/templates/list"=>Ok(json!({"resourceTemplates":[{"name":"item","uriTemplate":"test://item/{id}"}]})),
                                "skills/list"=>Ok(json!({"resultType":"complete","ttlMs":0,"cacheScope":"server","skills":[skill_entry()]})),
                                "skills/get"=>Ok(json!({"resultType":"complete","ttlMs":0,"cacheScope":"server","skill":if state.wrong_skill {let mut value=skill_entry();value["uri"]=json!("skill://other/SKILL.md");value}else{skill_entry()}})),
                                "resources/directory/read"=>Ok(json!({"resultType":"complete","resources":[{"uri":"skill://a/SKILL.md","name":"SKILL.md"}]})),
                                "resources/read"=>Ok(json!({"contents":[{"uri":params["uri"],"text":if state.corrupt{"# Other\n"}else{"# Guide\n"}}]})),
                                _=>Err(-32601),
                            };
                            let response=match result {Ok(result)=>json!({"jsonrpc":"2.0","id":body["id"],"result":result}),Err(code)=>json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":code,"message":"Method not found"}})};
                            if state.sse{(200,"text/event-stream",format!("event: message\ndata: {response}\n\n"))}else{(200,"application/json",response.to_string())}
                        }};
                        let headers=format!("HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
                        stream.write_all(headers.as_bytes()).await.unwrap();stream.write_all(response.as_bytes()).await.unwrap();
                    });},
                    completed=connections.join_next(),if !connections.is_empty()=>{completed.unwrap().unwrap();},
                }
            }
        });
        Self { url, state, task }
    }
    fn config(&self) -> ServerConfig {
        ServerConfig::decode(&parse_json(&json!({"type":"remote","url":self.url,"oauth":false,"headers":{"X-Fixture":"mcp-test"}}).to_string()).unwrap()).unwrap()
    }
    async fn connect(&self) -> Connection {
        Connection::connect(
            "loopback",
            &self.config(),
            &std::env::temp_dir(),
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        )
        .await
        .unwrap()
    }
    async fn close(self) {
        self.task.abort();
        assert!(self.task.await.unwrap_err().is_cancelled());
    }
}

fn skill_entry() -> Value {
    json!({"uri":"skill://a/SKILL.md","frontmatter":{"name":"a","description":"d"},"resources":[{"uri":"skill://a/SKILL.md","digest":ycoding_core::resources::mcp::skills::digest(b"# Guide\n"),"size":8}]})
}

#[tokio::test]
async fn real_http_json_and_sse_catalog_call_prompt_resource_and_skill_flow() {
    for sse in [false, true] {
        let server = Server::new(sse).await;
        let connection = server.connect().await;
        assert_eq!(
            connection.instructions.as_deref(),
            Some("Use loopback tools.")
        );
        assert_eq!(connection.tools().await.unwrap().len(), 2);
        assert_eq!(
            connection.call_tool("first", json!({}), None).await,
            Err(Error::OutputSchema)
        );
        assert_eq!(
            connection
                .call_tool("second", json!({}), None)
                .await
                .unwrap()
                .structured,
            Some(json!({"value":1}))
        );
        assert_eq!(connection.prompts().await.unwrap()[0]["name"], "hello");
        assert_eq!(
            connection
                .prompt("hello", json!({"person":"Ada"}), None)
                .await
                .unwrap()["messages"][0]["content"]["text"],
            "Hello"
        );
        assert_eq!(
            connection.resources().await.unwrap()[0]["uri"],
            "test://readme"
        );
        assert_eq!(
            connection.resource_templates().await.unwrap()[0]["uriTemplate"],
            "test://item/{id}"
        );
        let entries = connection.skill_entries().await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            connection.skill_entry("skill://a/SKILL.md").await.unwrap(),
            entries[0]
        );
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|request| request.2["method"] == "resources/read")
                .count(),
            0
        );
        assert_eq!(
            connection
                .read_resource_directory("skill://a")
                .await
                .unwrap()
                .unwrap()[0]["name"],
            "SKILL.md"
        );
        assert!(
            connection
                .read_skill_resource(&entries[0], "skill://a/SKILL.md")
                .await
                .is_ok()
        );
        let mut other = entries[0].clone();
        other.server = "other".into();
        assert_eq!(
            connection
                .read_skill_resource(&other, "skill://a/SKILL.md")
                .await,
            Err(Error::Skill(Reason::OriginMismatch))
        );
        server.state.lock().unwrap().corrupt = true;
        assert_eq!(
            connection
                .read_skill_resource(&entries[0], "skill://a/SKILL.md")
                .await,
            Err(Error::Skill(Reason::DigestMismatch))
        );
        connection.close().await.unwrap();
        server.close().await;
    }
}

#[tokio::test]
async fn unsupported_resource_methods_are_cached_and_duplicate_cursors_fail() {
    let server = Server::new(false).await;
    let connection = server.connect().await;
    server.state.lock().unwrap().unsupported = true;
    assert!(connection.resources().await.unwrap().is_empty());
    assert!(connection.resources().await.unwrap().is_empty());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|request| request.2["method"] == "resources/list")
            .count(),
        1
    );
    server.state.lock().unwrap().duplicate = true;
    assert!(
        connection
            .tools()
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("duplicate cursor")
    );
    server.state.lock().unwrap().wrong_skill = true;
    assert_eq!(
        connection.skill_entry("skill://a/SKILL.md").await,
        Err(Error::Skill(Reason::UriMismatch))
    );
    connection.close().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn wire_headers_and_close_match_the_typescript_transport_contract() {
    let server = Server::new(false).await;
    let connection = server.connect().await;
    connection.tools().await.unwrap();
    connection.close().await.unwrap();
    {
        let requests = server.state.lock().unwrap();
        let initialize = requests
            .requests
            .iter()
            .find(|request| request.2["method"] == "initialize")
            .unwrap();
        assert_eq!(initialize.2["params"]["protocolVersion"], "2025-11-25");
        assert!(
            !initialize
                .1
                .to_ascii_lowercase()
                .contains("mcp-protocol-version:")
        );
        assert!(
            initialize
                .1
                .to_ascii_lowercase()
                .contains("x-fixture: mcp-test")
        );
        let list = requests
            .requests
            .iter()
            .find(|request| request.2["method"] == "tools/list")
            .unwrap();
        assert!(
            list.1
                .to_ascii_lowercase()
                .contains("mcp-protocol-version: 2025-11-25")
        );
        assert!(list.2["params"].get("_meta").is_none());
        assert!(
            !requests
                .requests
                .iter()
                .any(|request| request.0 == "DELETE")
        );
    }
    server.close().await;
}

#[tokio::test]
async fn output_schema_string_lengths_count_unicode_code_points_not_utf16_units() {
    let server = Server::new(false).await;
    server.state.lock().unwrap().unicode_output = true;
    let connection = server.connect().await;
    connection.tools().await.unwrap();
    assert_eq!(
        connection.call_tool("first", json!({}), None).await,
        Err(Error::OutputSchema)
    );
    connection.close().await.unwrap();
    server.close().await;
}
