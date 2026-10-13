use super::DiagnosticKind;
use super::program::{
    Expression, ExpressionKind, Function, Pattern, Position, Property, Statement, StatementKind,
    blocked,
};
use super::promises::Jobs;
use super::runtime::{Cancellation, ExecutionLimits, ToolHost};
use super::values::{
    Binding, Closure, Fault, Heap, State, Value, concat, field, identical, index, int32, put,
    truthy, type_of, uint32,
};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use ycoding_schema::LosslessString;

type EvalFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Fault>> + Send + 'a>>;

#[derive(Clone)]
pub(crate) struct Vm {
    data: Arc<Mutex<State>>,
    pub jobs: Arc<Mutex<Jobs>>,
    pub host: Arc<dyn ToolHost>,
    pub limits: ExecutionLimits,
    pub caller_cancel: Cancellation,
    pub work_cancel: Cancellation,
    pub started: Instant,
    pub origin: Position,
    pub regexp: Arc<dyn super::regexp::RegExpEngine>,
    pub current_task: Arc<AtomicUsize>,
    steps: Arc<AtomicUsize>,
    pub collator: Arc<super::runtime::Collation>,
}

#[derive(Clone)]
enum Flow {
    Normal,
    Return(Value),
    Break,
    Continue,
}

enum Target {
    Identifier(String),
    Member(Value, LosslessString),
}

impl Vm {
    pub fn new(
        host: Arc<dyn ToolHost>,
        limits: ExecutionLimits,
        cancel: Cancellation,
        regexp: Arc<dyn super::regexp::RegExpEngine>,
        collator: Arc<super::runtime::Collation>,
    ) -> Self {
        let mut state = State {
            random: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(1, |time| (time.as_nanos() as u64) | 1),
            ..State::default()
        };
        let mut globals = HashMap::new();
        globals.insert(
            "tools".into(),
            Binding {
                value: Value::Tool(Vec::new()),
                initialized: true,
                mutable: false,
            },
        );
        globals.insert(
            "undefined".into(),
            Binding {
                value: Value::Undefined,
                initialized: true,
                mutable: false,
            },
        );
        globals.insert(
            "NaN".into(),
            Binding {
                value: Value::Number(f64::NAN),
                initialized: true,
                mutable: false,
            },
        );
        globals.insert(
            "Infinity".into(),
            Binding {
                value: Value::Number(f64::INFINITY),
                initialized: true,
                mutable: false,
            },
        );
        for name in [
            "search",
            "Object",
            "Math",
            "JSON",
            "Number",
            "String",
            "Boolean",
            "Array",
            "console",
            "parseInt",
            "parseFloat",
            "isFinite",
            "isNaN",
            "Date",
            "RegExp",
            "Map",
            "Set",
            "URL",
            "URLSearchParams",
            "Promise",
            "encodeURI",
            "encodeURIComponent",
            "decodeURI",
            "decodeURIComponent",
            "Error",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "ReferenceError",
            "EvalError",
            "URIError",
            "AggregateError",
        ] {
            globals.insert(
                name.into(),
                Binding {
                    value: Value::Namespace(name.into()),
                    initialized: true,
                    mutable: false,
                },
            );
        }
        state.scopes.push(globals);
        Self {
            data: Arc::new(Mutex::new(state)),
            jobs: Arc::new(Mutex::new(Jobs::default())),
            host,
            limits,
            caller_cancel: cancel,
            work_cancel: Cancellation::default(),
            started: Instant::now(),
            origin: Position {
                index: 0,
                line: 1,
                column: 0,
            },
            regexp,
            current_task: Arc::new(AtomicUsize::new(usize::MAX)),
            steps: Arc::new(AtomicUsize::new(0)),
            collator,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.data.lock().expect("Code Mode value store poisoned")
    }

    pub fn checkpoint(&self, location: &Position) -> Result<(), Fault> {
        if self.caller_cancel.is_cancelled() || self.work_cancel.is_cancelled() {
            return Err(self.interrupted(location));
        }
        if let Some(timeout) = self.limits.timeout_ms
            && self.started.elapsed().as_millis() >= timeout as u128
        {
            return Err(Fault {
                kind: DiagnosticKind::TimeoutExceeded,
                message: format!("Execution timed out after {timeout}ms."),
                fatal: true,
                ..Fault::error("Error", "", location)
            });
        }
        Ok(())
    }

    pub fn interrupted(&self, location: &Position) -> Fault {
        Fault {
            message: "Execution interrupted.".into(),
            fatal: true,
            ..Fault::error("Error", "", location)
        }
    }

    async fn cooperate(&self, location: &Position) -> Result<(), Fault> {
        self.checkpoint(location)?;
        if self.steps.fetch_add(1, Ordering::Relaxed) % 1024 != 1023 {
            return Ok(());
        }
        let mut yielded = false;
        std::future::poll_fn(|cx| {
            if yielded {
                return std::task::Poll::Ready(());
            }
            yielded = true;
            {
                let id = self.current_task.load(Ordering::Relaxed);
                let mut jobs = self.jobs.lock().expect("Code Mode reaction queue poisoned");
                jobs.ready.retain(|queued| *queued != id);
                jobs.ready.push_front(id);
                jobs.preempted = true;
            }
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        })
        .await;
        self.checkpoint(location)
    }

    fn scope(&self, scopes: &[usize]) -> Vec<usize> {
        let mut scopes = scopes.to_vec();
        let mut state = self.state();
        scopes.push(state.scopes.len());
        state.scopes.push(HashMap::new());
        scopes
    }

    fn fork_loop_scope(&self, scopes: &mut [usize]) {
        let mut state = self.state();
        let scope = state.scopes[*scopes.last().expect("Code Mode loop scope")].clone();
        let id = state.scopes.len();
        state.scopes.push(scope);
        *scopes.last_mut().expect("Code Mode loop scope") = id;
    }

    fn declare(&self, scopes: &[usize], pattern: &Pattern, mutable: bool) {
        let mut names = Vec::new();
        pattern_names(pattern, &mut names);
        let mut state = self.state();
        let scope = &mut state.scopes[*scopes.last().expect("Code Mode lexical scope")];
        for name in names {
            scope.entry(name).or_insert(Binding {
                value: Value::Undefined,
                initialized: false,
                mutable,
            });
        }
    }

    fn predeclare(&self, scopes: &[usize], body: &[Statement]) {
        for statement in body {
            if let StatementKind::Declare(declarations) = &statement.kind {
                for declaration in declarations {
                    if declaration.lexical {
                        self.declare(scopes, &declaration.pattern, declaration.mutable);
                    }
                }
            }
        }
        for statement in body {
            if let StatementKind::Function(function) = &statement.kind
                && let Some(name) = &function.name
            {
                let value = self.closure(function, scopes);
                self.state().scopes[*scopes.last().expect("Code Mode lexical scope")].insert(
                    name.clone(),
                    Binding {
                        value,
                        initialized: true,
                        mutable: true,
                    },
                );
            }
        }
    }

    fn closure(&self, function: &Function, scopes: &[usize]) -> Value {
        Value::Function(self.state().allocate(Heap::Function(Closure {
            function: Arc::new(function.clone()),
            scopes: scopes.to_vec(),
        })))
    }

    fn lookup(&self, scopes: &[usize], name: &str, location: &Position) -> Result<Value, Fault> {
        let state = self.state();
        for scope in scopes.iter().rev() {
            if let Some(binding) = state.scopes[*scope].get(name) {
                if !binding.initialized {
                    return Err(Fault::error(
                        "ReferenceError",
                        format!("Cannot access '{name}' before initialization."),
                        location,
                    ));
                }
                return Ok(binding.value.clone());
            }
        }
        Err(Fault::error(
            "ReferenceError",
            format!("Unknown identifier '{name}'."),
            location,
        ))
    }

    fn assign_identifier(
        &self,
        scopes: &[usize],
        name: &str,
        value: Value,
        declaration: Option<bool>,
        location: &Position,
    ) -> Result<(), Fault> {
        let mut state = self.state();
        if let Some(mutable) = declaration {
            let scope = &mut state.scopes[*scopes.last().expect("Code Mode lexical scope")];
            scope.insert(
                name.into(),
                Binding {
                    value,
                    mutable,
                    initialized: true,
                },
            );
            return Ok(());
        }
        for scope in scopes.iter().rev() {
            if let Some(binding) = state.scopes[*scope].get_mut(name) {
                if !binding.initialized {
                    return Err(Fault::error(
                        "ReferenceError",
                        format!("Cannot access '{name}' before initialization."),
                        location,
                    ));
                }
                if !binding.mutable {
                    return Err(Fault::error(
                        "TypeError",
                        format!("Cannot assign to constant '{name}'."),
                        location,
                    ));
                }
                binding.value = value;
                return Ok(());
            }
        }
        Err(Fault::error(
            "ReferenceError",
            format!("Unknown identifier '{name}'."),
            location,
        ))
    }

    pub async fn run(&self, body: &[Statement]) -> Result<Value, Fault> {
        let scopes = self.scope(&[0]);
        self.predeclare(&scopes, body);
        for (index, statement) in body.iter().enumerate() {
            if index + 1 == body.len()
                && let StatementKind::Expression(expression) = &statement.kind
            {
                let value = self.evaluate(expression, &scopes).await?;
                return self.adopt(value).await;
            }
            match self.statement(statement, &scopes).await? {
                Flow::Return(value) => return self.adopt(value).await,
                Flow::Break | Flow::Continue => {
                    return Err(Fault::error(
                        "Error",
                        "Unexpected loop control outside of a loop.",
                        &statement.location,
                    ));
                }
                Flow::Normal => {}
            }
        }
        Ok(Value::Undefined)
    }

    pub async fn adopt(&self, value: Value) -> Result<Value, Fault> {
        if matches!(value, Value::Promise(_)) {
            self.await_value(value).await
        } else {
            Ok(value)
        }
    }

    fn body<'a>(
        &'a self,
        body: &'a [Statement],
        scopes: &'a [usize],
        new_scope: bool,
    ) -> EvalFuture<'a, Flow> {
        Box::pin(async move {
            let scopes = if new_scope {
                self.scope(scopes)
            } else {
                scopes.to_vec()
            };
            self.predeclare(&scopes, body);
            for statement in body {
                let flow = self.statement(statement, &scopes).await?;
                if !matches!(flow, Flow::Normal) {
                    return Ok(flow);
                }
            }
            Ok(Flow::Normal)
        })
    }

    fn statement<'a>(&'a self, node: &'a Statement, scopes: &'a [usize]) -> EvalFuture<'a, Flow> {
        Box::pin(async move {
            self.cooperate(&node.location).await?;
            match &node.kind {
                StatementKind::Empty | StatementKind::Function(_) => Ok(Flow::Normal),
                StatementKind::Expression(value) => {
                    self.evaluate(value, scopes).await?;
                    Ok(Flow::Normal)
                }
                StatementKind::Declare(declarations) => {
                    for declaration in declarations {
                        let value = match &declaration.value {
                            Some(value) => self.evaluate(value, scopes).await?,
                            None => Value::Undefined,
                        };
                        self.bind(
                            &declaration.pattern,
                            value,
                            scopes,
                            Some(declaration.mutable),
                            &node.location,
                        )
                        .await?;
                    }
                    Ok(Flow::Normal)
                }
                StatementKind::Block(body) => self.body(body, scopes, true).await,
                StatementKind::Return(value) => Ok(Flow::Return(match value {
                    Some(value) => self.evaluate(value, scopes).await?,
                    None => Value::Undefined,
                })),
                StatementKind::If(test, yes, no) => {
                    if truthy(&self.evaluate(test, scopes).await?) {
                        return self.statement(yes, scopes).await;
                    }
                    match no {
                        Some(no) => self.statement(no, scopes).await,
                        None => Ok(Flow::Normal),
                    }
                }
                StatementKind::While(test, body, first) => {
                    let mut first = *first;
                    loop {
                        self.checkpoint(&node.location)?;
                        if !first && !truthy(&self.evaluate(test, scopes).await?) {
                            break;
                        }
                        first = false;
                        match self.statement(body, scopes).await? {
                            Flow::Return(value) => return Ok(Flow::Return(value)),
                            Flow::Break => break,
                            Flow::Normal | Flow::Continue => {}
                        }
                    }
                    Ok(Flow::Normal)
                }
                StatementKind::For(init, test, update, body) => {
                    let mut scopes = self.scope(scopes);
                    let lexical = init.as_ref().and_then(|init| match &init.kind {
                        StatementKind::Declare(declarations) => Some(declarations),
                        _ => None,
                    });
                    if let Some(declarations) = lexical {
                        for declaration in declarations {
                            if declaration.lexical {
                                self.declare(&scopes, &declaration.pattern, declaration.mutable);
                            }
                        }
                    }
                    if let Some(init) = init {
                        self.statement(init, &scopes).await?;
                    }
                    if lexical.is_some_and(|items| items.iter().any(|item| item.lexical)) {
                        self.fork_loop_scope(&mut scopes);
                    }
                    loop {
                        self.checkpoint(&node.location)?;
                        if let Some(test) = test
                            && !truthy(&self.evaluate(test, &scopes).await?)
                        {
                            break;
                        }
                        match self.statement(body, &scopes).await? {
                            Flow::Return(value) => return Ok(Flow::Return(value)),
                            Flow::Break => break,
                            Flow::Normal | Flow::Continue => {}
                        }
                        if lexical.is_some_and(|items| items.iter().any(|item| item.lexical)) {
                            self.fork_loop_scope(&mut scopes);
                        }
                        if let Some(update) = update {
                            self.evaluate(update, &scopes).await?;
                        }
                    }
                    Ok(Flow::Normal)
                }
                StatementKind::Iterate(declaration, pattern, right, body, keys) => {
                    let head = self.scope(scopes);
                    if let Some(declaration) = declaration
                        && declaration.lexical
                    {
                        self.declare(&head, pattern, declaration.mutable);
                    }
                    let source = self.evaluate(right, &head).await?;
                    let values = if *keys {
                        if !matches!(source, Value::Object(_) | Value::Array(_) | Value::Tool(_)) {
                            return Err(Fault::data(
                                "for...in requires a plain object, array, or tools reference. Use for...of for arrays/strings/Maps/Sets, or Object.keys(value).",
                            ));
                        }
                        self.keys(&source, &node.location)?
                            .into_iter()
                            .map(Value::String)
                            .collect()
                    } else {
                        self.iterable(&source, &node.location)?
                    };
                    for value in values {
                        self.checkpoint(&node.location)?;
                        let scopes = if declaration.as_ref().is_some_and(|value| value.lexical) {
                            self.scope(&head)
                        } else {
                            head.clone()
                        };
                        self.bind(
                            pattern,
                            value,
                            &scopes,
                            declaration.as_ref().map(|value| value.mutable),
                            &node.location,
                        )
                        .await?;
                        match self.statement(body, &scopes).await? {
                            Flow::Return(value) => return Ok(Flow::Return(value)),
                            Flow::Break => break,
                            Flow::Normal | Flow::Continue => {}
                        }
                    }
                    Ok(Flow::Normal)
                }
                StatementKind::Break => Ok(Flow::Break),
                StatementKind::Continue => Ok(Flow::Continue),
                StatementKind::Switch(expression, cases) => {
                    let value = self.evaluate(expression, scopes).await?;
                    let scopes = self.scope(scopes);
                    let all = cases
                        .iter()
                        .flat_map(|(_, body)| body.clone())
                        .collect::<Vec<_>>();
                    self.predeclare(&scopes, &all);
                    let mut selected = None;
                    let mut default = None;
                    for (index, (test, _)) in cases.iter().enumerate() {
                        match test {
                            Some(test) => {
                                if identical(&value, &self.evaluate(test, &scopes).await?, false) {
                                    selected = Some(index);
                                    break;
                                }
                            }
                            None => default = Some(index),
                        }
                    }
                    if let Some(selected) = selected.or(default) {
                        for (_, body) in &cases[selected..] {
                            for statement in body {
                                match self.statement(statement, &scopes).await? {
                                    Flow::Break => return Ok(Flow::Normal),
                                    Flow::Normal => {}
                                    flow => return Ok(flow),
                                }
                            }
                        }
                    }
                    Ok(Flow::Normal)
                }
                StatementKind::Throw(expression) => {
                    let value = self.evaluate(expression, scopes).await?;
                    Err(self.thrown(value, &node.location))
                }
                StatementKind::Try(body, handler, finalizer) => {
                    let result = self.body(body, scopes, true).await;
                    if result.as_ref().err().is_some_and(|fault| fault.fatal) {
                        return result;
                    }
                    let result = match (result, handler) {
                        (Err(fault), Some((pattern, body))) => {
                            let scopes = self.scope(scopes);
                            if let Some(pattern) = pattern {
                                let value = self.state().caught(&fault);
                                self.bind(pattern, value, &scopes, Some(true), &node.location)
                                    .await?;
                            }
                            self.body(body, &scopes, false).await
                        }
                        (result, _) => result,
                    };
                    if let Some(finalizer) = finalizer {
                        let flow = self.body(finalizer, scopes, true).await?;
                        if !matches!(flow, Flow::Normal) {
                            return Ok(flow);
                        }
                    }
                    result
                }
            }
        })
    }

    pub fn evaluate<'a>(
        &'a self,
        node: &'a Expression,
        scopes: &'a [usize],
    ) -> EvalFuture<'a, Value> {
        Box::pin(async move {
            self.cooperate(&node.location).await?;
            match &node.kind {
                ExpressionKind::Null => Ok(Value::Null),
                ExpressionKind::Boolean(value) => Ok(Value::Boolean(*value)),
                ExpressionKind::Number(value) => Ok(Value::Number(*value)),
                ExpressionKind::String(value) => Ok(Value::String(value.clone())),
                ExpressionKind::Identifier(name) => self.lookup(scopes, name, &node.location),
                ExpressionKind::Array(items) => {
                    let mut entries = std::collections::BTreeMap::new();
                    let mut length = 0u32;
                    for item in items {
                        match item {
                            Some(item) => {
                                let value = self.evaluate(&item.value, scopes).await?;
                                if item.spread {
                                    for value in self.iterable(&value, &node.location)? {
                                        entries.insert(length, value);
                                        length = length.checked_add(1).ok_or_else(|| {
                                            Fault::error(
                                                "RangeError",
                                                "Invalid array length",
                                                &node.location,
                                            )
                                        })?;
                                    }
                                } else {
                                    entries.insert(length, value);
                                    length = length.checked_add(1).ok_or_else(|| {
                                        Fault::error(
                                            "RangeError",
                                            "Invalid array length",
                                            &node.location,
                                        )
                                    })?;
                                }
                            }
                            None => {
                                length = length.checked_add(1).ok_or_else(|| {
                                    Fault::error(
                                        "RangeError",
                                        "Invalid array length",
                                        &node.location,
                                    )
                                })?
                            }
                        }
                    }
                    Ok(Value::Array(self.state().allocate(Heap::Array {
                        length,
                        items: entries,
                        fields: Vec::new(),
                    })))
                }
                ExpressionKind::Object(properties) => {
                    let mut fields = Vec::new();
                    for property in properties {
                        match property {
                            Property::Field(key, value) => {
                                let key = self.evaluate(key, scopes).await?;
                                let key = self.state().text(&key)?;
                                self.require_key(&key, &node.location)?;
                                let value = self.evaluate(value, scopes).await?;
                                put(&mut fields, key, value)
                            }
                            Property::Spread(source) => {
                                let source = self.evaluate(source, scopes).await?;
                                match source {
                                    Value::Null
                                    | Value::Undefined
                                    | Value::Date(_)
                                    | Value::RegExp(_)
                                    | Value::Map(_)
                                    | Value::Set(_)
                                    | Value::Url(_)
                                    | Value::Params(_) => {}
                                    Value::Object(_) => {
                                        for key in self.keys(&source, &node.location)? {
                                            let value = self.get(&source, &key, &node.location)?;
                                            put(&mut fields, key, value)
                                        }
                                    }
                                    _ => {
                                        return Err(Fault::data_at(
                                            "Object spread requires a data object in CodeMode.",
                                            &node.location,
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    Ok(self.state().object(fields))
                }
                ExpressionKind::Template(parts, expressions) => {
                    let mut values = Vec::new();
                    for (index, part) in parts.iter().enumerate() {
                        values.push(part.clone());
                        if let Some(expression) = expressions.get(index) {
                            let value = self.evaluate(expression, scopes).await?;
                            values.push(self.state().text(&value)?);
                        }
                    }
                    Ok(Value::String(concat(&values)))
                }
                ExpressionKind::RegExp(pattern, flags) => {
                    self.construct_regexp(pattern, flags, &node.location)
                }
                ExpressionKind::Function(function) => Ok(self.closure(function, scopes)),
                ExpressionKind::Member(object, key, optional) => {
                    let object = self.evaluate(object, scopes).await?;
                    if matches!(object, Value::ShortCircuit)
                        || (*optional && matches!(object, Value::Null | Value::Undefined))
                    {
                        return Ok(Value::ShortCircuit);
                    }
                    let key = self.evaluate(key, scopes).await?;
                    let key = self.state().text(&key)?;
                    self.get(&object, &key, &node.location)
                }
                ExpressionKind::Call(callee, arguments, optional, construct) => {
                    let callable = self.evaluate(callee, scopes).await?;
                    if matches!(callable, Value::ShortCircuit)
                        || (*optional && matches!(callable, Value::Null | Value::Undefined))
                    {
                        return Ok(Value::ShortCircuit);
                    }
                    let mut values = Vec::new();
                    for argument in arguments {
                        let value = self.evaluate(&argument.value, scopes).await?;
                        if argument.spread {
                            values.extend(self.iterable(&value, &node.location)?)
                        } else {
                            values.push(value)
                        }
                    }
                    if !matches!(
                        callable,
                        Value::Function(_)
                            | Value::Namespace(_)
                            | Value::Intrinsic(_, _)
                            | Value::Tool(_)
                            | Value::Resolver(_, _)
                    ) {
                        let description = match &callee.kind {
                            ExpressionKind::Identifier(name) => name.clone(),
                            ExpressionKind::Member(object, key, _) => {
                                match (&object.kind, &key.kind) {
                                    (
                                        ExpressionKind::Identifier(name),
                                        ExpressionKind::String(key),
                                    ) => format!(
                                        "{name}.{}",
                                        key.to_utf8()
                                            .map_err(|_| Fault::data("Invalid callee name."))?
                                    ),
                                    _ => "The called value".into(),
                                }
                            }
                            _ => "The called value".into(),
                        };
                        return Err(Fault::error(
                            "TypeError",
                            format!("{description} is not a function."),
                            &callee.location,
                        ));
                    }
                    self.call(callable, values, *construct, &node.location)
                        .await
                }
                ExpressionKind::Unary(operator, expression) => {
                    if operator == "typeof"
                        && let ExpressionKind::Identifier(name) = &expression.kind
                    {
                        match self.lookup(scopes, name, &node.location) {
                            Ok(value) => return Ok(Value::String(type_of(&value).into())),
                            Err(fault) if fault.message.starts_with("Unknown identifier") => {
                                return Ok(Value::String("undefined".into()));
                            }
                            Err(fault) => return Err(fault),
                        }
                    }
                    if operator == "delete" {
                        return self.delete(expression, scopes, &node.location).await;
                    }
                    let value = self.evaluate(expression, scopes).await?;
                    match operator.as_str() {
                        "!" => Ok(Value::Boolean(!truthy(&value))),
                        "+" => Ok(Value::Number(self.state().number(&value)?)),
                        "-" => Ok(Value::Number(-self.state().number(&value)?)),
                        "~" => Ok(Value::Number((!int32(self.state().number(&value)?)) as f64)),
                        "void" => Ok(Value::Undefined),
                        "typeof" => Ok(Value::String(type_of(&value).into())),
                        _ => Err(Fault::error(
                            "Error",
                            "Unknown unary operator.",
                            &node.location,
                        )),
                    }
                }
                ExpressionKind::Binary(operator, left, right) => {
                    let left = self.evaluate(left, scopes).await?;
                    let right = self.evaluate(right, scopes).await?;
                    self.binary(operator, left, right, &node.location)
                }
                ExpressionKind::Logical(operator, left, right) => {
                    let value = self.evaluate(left, scopes).await?;
                    let take = match operator.as_str() {
                        "&&" => truthy(&value),
                        "||" => !truthy(&value),
                        "??" => matches!(value, Value::Null | Value::Undefined),
                        _ => false,
                    };
                    if take {
                        self.evaluate(right, scopes).await
                    } else {
                        Ok(value)
                    }
                }
                ExpressionKind::Conditional(test, yes, no) => {
                    if truthy(&self.evaluate(test, scopes).await?) {
                        self.evaluate(yes, scopes).await
                    } else {
                        self.evaluate(no, scopes).await
                    }
                }
                ExpressionKind::Assign(operator, pattern, right) => {
                    if operator == "=" {
                        if matches!(pattern, Pattern::Member(_, _)) {
                            let target = self.target(pattern, scopes, &node.location).await?;
                            let value = self.evaluate(right, scopes).await?;
                            self.write_target(target, value.clone(), scopes, &node.location)?;
                            return Ok(value);
                        }
                        let value = self.evaluate(right, scopes).await?;
                        self.bind(pattern, value.clone(), scopes, None, &node.location)
                            .await?;
                        return Ok(value);
                    }
                    let target = self.target(pattern, scopes, &node.location).await?;
                    let old = self.read_target(&target, scopes, &node.location)?;
                    if (operator == "&&=" && !truthy(&old))
                        || (operator == "||=" && truthy(&old))
                        || (operator == "??=" && !matches!(old, Value::Null | Value::Undefined))
                    {
                        return Ok(old);
                    }
                    let right = self.evaluate(right, scopes).await?;
                    let value = if ["&&=", "||=", "??="].contains(&operator.as_str()) {
                        right
                    } else {
                        self.binary(operator.trim_end_matches('='), old, right, &node.location)?
                    };
                    self.write_target(target, value.clone(), scopes, &node.location)?;
                    Ok(value)
                }
                ExpressionKind::Update(operator, pattern, prefix) => {
                    let target = self.target(pattern, scopes, &node.location).await?;
                    let value = self.read_target(&target, scopes, &node.location)?;
                    let value = self.state().number(&value)?;
                    let next = value + if operator == "++" { 1.0 } else { -1.0 };
                    self.write_target(target, Value::Number(next), scopes, &node.location)?;
                    Ok(Value::Number(if *prefix { next } else { value }))
                }
                ExpressionKind::Sequence(expressions) => {
                    let mut value = Value::Undefined;
                    for expression in expressions {
                        value = self.evaluate(expression, scopes).await?;
                    }
                    Ok(value)
                }
                ExpressionKind::Await(expression) => {
                    let value = self.evaluate(expression, scopes).await?;
                    self.await_value(value).await
                }
                ExpressionKind::Chain(expression) => {
                    let value = self.evaluate(expression, scopes).await?;
                    Ok(if matches!(value, Value::ShortCircuit) {
                        Value::Undefined
                    } else {
                        value
                    })
                }
            }
        })
    }

    fn bind<'a>(
        &'a self,
        pattern: &'a Pattern,
        value: Value,
        scopes: &'a [usize],
        declaration: Option<bool>,
        location: &'a Position,
    ) -> EvalFuture<'a, ()> {
        Box::pin(async move {
            match pattern {
                Pattern::Identifier(name) => {
                    self.assign_identifier(scopes, name, value, declaration, location)
                }
                Pattern::Member(object, key) => {
                    let object = self.evaluate(object, scopes).await?;
                    let key = self.evaluate(key, scopes).await?;
                    let key = self.state().text(&key)?;
                    self.set(&object, key, value, location)
                }
                Pattern::Default(pattern, default) => {
                    let value = if matches!(value, Value::Undefined) {
                        self.evaluate(default, scopes).await?
                    } else {
                        value
                    };
                    self.bind(pattern, value, scopes, declaration, location)
                        .await
                }
                Pattern::Array(patterns, rest) => {
                    let items = self.iterable(&value, location)?;
                    for (index, pattern) in patterns.iter().enumerate() {
                        if let Some(pattern) = pattern {
                            self.bind(
                                pattern,
                                items.get(index).cloned().unwrap_or(Value::Undefined),
                                scopes,
                                declaration,
                                location,
                            )
                            .await?;
                        }
                    }
                    if let Some(rest) = rest {
                        let value = self
                            .state()
                            .array(items.into_iter().skip(patterns.len()).collect());
                        self.bind(rest, value, scopes, declaration, location)
                            .await?;
                    }
                    Ok(())
                }
                Pattern::Object(patterns, rest) => {
                    if matches!(value, Value::Null | Value::Undefined) {
                        return Err(Fault::error(
                            "TypeError",
                            "Cannot destructure a nullish value.",
                            location,
                        ));
                    }
                    let mut keys = Vec::new();
                    for (key, pattern) in patterns {
                        let key = self.evaluate(key, scopes).await?;
                        if !matches!(key, Value::String(_) | Value::Number(_)) {
                            return Err(Fault::error(
                                "TypeError",
                                "Property key must be a string or number.",
                                location,
                            ));
                        }
                        let key = self.state().text(&key)?;
                        let item = self.get(&value, &key, location)?;
                        keys.push(key);
                        self.bind(pattern, item, scopes, declaration, location)
                            .await?;
                    }
                    if let Some(rest) = rest {
                        let fields = self
                            .keys(&value, location)?
                            .into_iter()
                            .filter(|key| !keys.contains(key))
                            .map(|key| self.get(&value, &key, location).map(|value| (key, value)))
                            .collect::<Result<_, _>>()?;
                        let value = self.state().object(fields);
                        self.bind(rest, value, scopes, declaration, location)
                            .await?;
                    }
                    Ok(())
                }
            }
        })
    }

    fn target<'a>(
        &'a self,
        pattern: &'a Pattern,
        scopes: &'a [usize],
        location: &'a Position,
    ) -> EvalFuture<'a, Target> {
        Box::pin(async move {
            match pattern {
                Pattern::Identifier(name) => Ok(Target::Identifier(name.clone())),
                Pattern::Member(object, key) => {
                    let object = self.evaluate(object, scopes).await?;
                    let key = self.evaluate(key, scopes).await?;
                    let key = self.state().text(&key)?;
                    self.require_key(&key, location)?;
                    if matches!(object, Value::Array(_))
                        && key.as_str() != Some("length")
                        && super::values::index(&key).is_none()
                    {
                        return Err(Fault::error(
                            "TypeError",
                            "Array assignment requires a non-negative integer index.",
                            location,
                        ));
                    }
                    Ok(Target::Member(object, key))
                }
                _ => Err(Fault::error(
                    "TypeError",
                    "Invalid assignment target.",
                    location,
                )),
            }
        })
    }
    fn read_target(
        &self,
        target: &Target,
        scopes: &[usize],
        location: &Position,
    ) -> Result<Value, Fault> {
        match target {
            Target::Identifier(name) => self.lookup(scopes, name, location),
            Target::Member(object, key) => self.get(object, key, location),
        }
    }
    fn write_target(
        &self,
        target: Target,
        value: Value,
        scopes: &[usize],
        location: &Position,
    ) -> Result<(), Fault> {
        match target {
            Target::Identifier(name) => {
                self.assign_identifier(scopes, &name, value, None, location)
            }
            Target::Member(object, key) => self.set(&object, key, value, location),
        }
    }

    pub fn require_key(&self, key: &LosslessString, location: &Position) -> Result<(), Fault> {
        if blocked(key) {
            return Err(Fault::error(
                "Error",
                format!(
                    "Property '{}' is not available in CodeMode.",
                    key.as_str().unwrap_or_default()
                ),
                location,
            ));
        }
        Ok(())
    }

    pub fn get(
        &self,
        value: &Value,
        key: &LosslessString,
        location: &Position,
    ) -> Result<Value, Fault> {
        let name = key.as_str().unwrap_or_default();
        if let Value::Namespace(namespace) = value
            && blocked(key)
        {
            return Err(Fault::error(
                "Error",
                format!("{namespace}.{name} is not available in CodeMode."),
                location,
            ));
        }
        if !matches!(value, Value::Tool(_)) {
            self.require_key(key, location)?;
        }
        match value {
            Value::Tool(path) => {
                let mut path = path.clone();
                path.extend(super::stdlib::discovery::segments(key));
                Ok(Value::Tool(path))
            }
            Value::Null | Value::Undefined => Err(Fault::error(
                "TypeError",
                format!("Cannot read property '{name}' of a nullish value."),
                location,
            )),
            Value::Object(id) => {
                let state = self.state();
                let Heap::Object { fields, .. } = &state.heap[*id] else {
                    return Err(Fault::data("Invalid object."));
                };
                Ok(field(fields, key).unwrap_or(Value::Undefined))
            }
            Value::Array(id) => {
                let state = self.state();
                let Heap::Array {
                    length,
                    items,
                    fields,
                } = &state.heap[*id]
                else {
                    return Err(Fault::data("Invalid array."));
                };
                if name == "length" {
                    return Ok(Value::Number(*length as f64));
                }
                if let Some(index) = index(key) {
                    return Ok(items.get(&index).cloned().unwrap_or(Value::Undefined));
                }
                if let Some(value) = field(fields, key) {
                    return Ok(value);
                }
                if super::stdlib::array_method(name) {
                    return Ok(Value::Intrinsic(Box::new(value.clone()), name.into()));
                }
                Ok(Value::Undefined)
            }
            Value::String(text) => {
                if name == "length" {
                    return Ok(Value::Number(text.len() as f64));
                }
                if let Some(index) = index(key) {
                    return Ok(text
                        .code_units()
                        .nth(index as usize)
                        .map_or(Value::Undefined, |unit| {
                            Value::String(LosslessString::from_utf16(vec![unit]))
                        }));
                }
                if super::stdlib::string_method(name) {
                    return Ok(Value::Intrinsic(Box::new(value.clone()), name.into()));
                }
                Ok(Value::Undefined)
            }
            Value::Number(_) => Ok(
                if [
                    "toFixed",
                    "toPrecision",
                    "toExponential",
                    "toString",
                    "valueOf",
                ]
                .contains(&name)
                {
                    Value::Intrinsic(Box::new(value.clone()), name.into())
                } else {
                    Value::Undefined
                },
            ),
            Value::Namespace(namespace) => super::stdlib::static_member(namespace, name),
            Value::Promise(_) if ["then", "catch", "finally"].contains(&name) => {
                Ok(Value::Intrinsic(Box::new(value.clone()), name.into()))
            }
            Value::Promise(_) => Err(Fault::data_at(
                "This value is an un-awaited Promise; await it first - e.g. `const result = await tools.ns.tool(...)`.",
                location,
            )),
            Value::Map(id) | Value::Set(id) => {
                let state = self.state();
                if name == "size" {
                    return Ok(Value::Number(match &state.heap[*id] {
                        Heap::Map(entries) => entries.len(),
                        Heap::Set { items, .. } => items.len(),
                        _ => 0,
                    } as f64));
                }
                let methods = if matches!(value, Value::Map(_)) {
                    &[
                        "get", "set", "has", "delete", "clear", "forEach", "keys", "values",
                        "entries",
                    ][..]
                } else {
                    &[
                        "add",
                        "has",
                        "delete",
                        "clear",
                        "forEach",
                        "keys",
                        "values",
                        "entries",
                        "union",
                        "intersection",
                        "difference",
                        "symmetricDifference",
                        "isSubsetOf",
                        "isSupersetOf",
                        "isDisjointFrom",
                    ][..]
                };
                Ok(if methods.contains(&name) {
                    Value::Intrinsic(Box::new(value.clone()), name.into())
                } else {
                    Value::Undefined
                })
            }
            Value::Date(_) => Ok(
                if [
                    "getTime",
                    "valueOf",
                    "toISOString",
                    "toJSON",
                    "toString",
                    "toUTCString",
                    "toGMTString",
                    "getFullYear",
                    "getMonth",
                    "getDate",
                    "getDay",
                    "getHours",
                    "getMinutes",
                    "getSeconds",
                    "getMilliseconds",
                    "getUTCFullYear",
                    "getUTCMonth",
                    "getUTCDate",
                    "getUTCDay",
                    "getUTCHours",
                    "getUTCMinutes",
                    "getUTCSeconds",
                    "getUTCMilliseconds",
                    "getTimezoneOffset",
                    "setTime",
                    "setMilliseconds",
                    "setUTCMilliseconds",
                    "setSeconds",
                    "setUTCSeconds",
                    "setMinutes",
                    "setUTCMinutes",
                    "setHours",
                    "setUTCHours",
                    "setDate",
                    "setUTCDate",
                    "setMonth",
                    "setUTCMonth",
                    "setFullYear",
                    "setUTCFullYear",
                ]
                .contains(&name)
                {
                    Value::Intrinsic(Box::new(value.clone()), name.into())
                } else {
                    Value::Undefined
                },
            ),
            Value::Url(id) => super::stdlib::url::get(self, *id, name, location),
            Value::Params(id) => {
                if name == "size" {
                    let state = self.state();
                    let Heap::Params { entries, .. } = &state.heap[*id] else {
                        return Err(Fault::data("Invalid URLSearchParams."));
                    };
                    return Ok(Value::Number(entries.len() as f64));
                }
                Ok(
                    if [
                        "append", "delete", "get", "getAll", "has", "set", "sort", "forEach",
                        "keys", "values", "entries", "toString",
                    ]
                    .contains(&name)
                    {
                        Value::Intrinsic(Box::new(value.clone()), name.into())
                    } else {
                        Value::Undefined
                    },
                )
            }
            Value::RegExp(id) => {
                let state = self.state();
                let Heap::RegExp {
                    pattern,
                    last_index,
                } = &state.heap[*id]
                else {
                    return Err(Fault::data("Invalid RegExp."));
                };
                let flags = pattern.flags();
                Ok(match name {
                    "lastIndex" => last_index.clone(),
                    "source" => {
                        Value::String(LosslessString::from_utf16(pattern.source().to_vec()))
                    }
                    "flags" => Value::String(flags.into()),
                    "global" | "ignoreCase" | "multiline" | "sticky" | "unicode"
                    | "unicodeSets" | "dotAll" | "hasIndices" => {
                        Value::Boolean(flags.contains(match name {
                            "global" => 'g',
                            "ignoreCase" => 'i',
                            "multiline" => 'm',
                            "sticky" => 'y',
                            "unicode" => 'u',
                            "unicodeSets" => 'v',
                            "dotAll" => 's',
                            _ => 'd',
                        }))
                    }
                    "test" | "exec" | "toString" => {
                        Value::Intrinsic(Box::new(value.clone()), name.into())
                    }
                    _ => Value::Undefined,
                })
            }
            Value::ShortCircuit => Ok(Value::ShortCircuit),
            Value::Boolean(_)
            | Value::Function(_)
            | Value::Intrinsic(_, _)
            | Value::Resolver(_, _) => Ok(Value::Undefined),
        }
    }

    pub fn set(
        &self,
        object: &Value,
        key: LosslessString,
        value: Value,
        location: &Position,
    ) -> Result<(), Fault> {
        self.require_key(&key, location)?;
        if let Value::RegExp(id) = object
            && key.as_str() == Some("lastIndex")
        {
            if let Heap::RegExp { last_index, .. } = &mut self.state().heap[*id] {
                *last_index = value;
            }
            return Ok(());
        }
        let id = match object {
            Value::Object(id) | Value::Array(id) => *id,
            Value::Url(id) => return super::stdlib::url::set(self, *id, &key, value, location),
            _ => {
                return Err(Fault::error(
                    "TypeError",
                    "Property assignment requires a plain object, array index, or writable URL field.",
                    location,
                ));
            }
        };
        self.reject_cycle(id, &value, location)?;
        let mut state = self.state();
        match &mut state.heap[id] {
            Heap::Object { fields, .. } => put(fields, key, value),
            Heap::Array { length, items, .. } => {
                let index = index(&key).ok_or_else(|| {
                    Fault::error(
                        "TypeError",
                        "Array assignment requires a non-negative integer index.",
                        location,
                    )
                })?;
                items.insert(index, value);
                *length = (*length).max(index + 1);
            }
            _ => return Err(Fault::data("Invalid property target.")),
        }
        Ok(())
    }

    pub fn reject_cycle(&self, id: usize, value: &Value, location: &Position) -> Result<(), Fault> {
        let state = self.state();
        let mut pending = vec![value.clone()];
        let mut seen = Vec::new();
        while let Some(value) = pending.pop() {
            let current = match value {
                Value::Array(current) | Value::Object(current) => current,
                _ => continue,
            };
            if current == id {
                return Err(Fault {
                    kind: DiagnosticKind::InvalidDataValue,
                    ..Fault::error("Error", "Assignment contains a circular value.", location)
                });
            }
            if seen.contains(&current) {
                continue;
            }
            seen.push(current);
            match &state.heap[current] {
                Heap::Array { items, .. } => pending.extend(items.values().cloned()),
                Heap::Object { fields, .. } => {
                    pending.extend(fields.iter().map(|(_, value)| value.clone()))
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn keys(&self, value: &Value, location: &Position) -> Result<Vec<LosslessString>, Fault> {
        match value {
            Value::Object(id) => {
                let state = self.state();
                let Heap::Object { fields, .. } = &state.heap[*id] else {
                    return Err(Fault::data("Invalid object."));
                };
                Ok(fields.iter().map(|(key, _)| key.clone()).collect())
            }
            Value::Array(id) => {
                let state = self.state();
                let Heap::Array { items, fields, .. } = &state.heap[*id] else {
                    return Err(Fault::data("Invalid array."));
                };
                Ok(items
                    .keys()
                    .map(|key| key.to_string().into())
                    .chain(fields.iter().map(|(key, _)| key.clone()))
                    .collect())
            }
            Value::Tool(path) => {
                let name = super::stdlib::discovery::joined(path);
                if !path.is_empty()
                    && !self.host.catalog().iter().any(|tool| {
                        super::stdlib::discovery::segments(&tool.path).starts_with(path)
                    })
                {
                    return Err(Fault {
                        kind: DiagnosticKind::UnknownTool,
                        ..Fault::error(
                            "Error",
                            format!(
                                "Unknown tool namespace '{}'.",
                                super::stdlib::discovery::display(&name)
                            ),
                            location,
                        )
                    });
                }
                let mut keys = Vec::new();
                for tool in self.host.catalog() {
                    let segments = super::stdlib::discovery::segments(&tool.path);
                    if segments.starts_with(path)
                        && let Some(key) = segments.get(path.len())
                        && !keys.contains(key)
                    {
                        keys.push(key.clone());
                    }
                }
                Ok(keys)
            }
            Value::String(value) => Ok((0..value.len())
                .map(|index| index.to_string().into())
                .collect()),
            _ => Err(Fault::error(
                "TypeError",
                "Enumeration expects an object, array, or tool reference.",
                location,
            )),
        }
    }

    pub fn iterable(&self, value: &Value, location: &Position) -> Result<Vec<Value>, Fault> {
        match value {
            Value::Array(id) => {
                let state = self.state();
                let Heap::Array { length, items, .. } = &state.heap[*id] else {
                    return Err(Fault::data("Invalid array."));
                };
                Ok((0..*length)
                    .map(|index| items.get(&index).cloned().unwrap_or(Value::Undefined))
                    .collect())
            }
            Value::String(value) => {
                let units = value.code_units().collect::<Vec<_>>();
                let mut values = Vec::new();
                let mut index = 0;
                while index < units.len() {
                    let length = if (0xd800..=0xdbff).contains(&units[index])
                        && units
                            .get(index + 1)
                            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                    {
                        2
                    } else {
                        1
                    };
                    values.push(Value::String(LosslessString::from_utf16(
                        units[index..index + length].to_vec(),
                    )));
                    index += length;
                }
                Ok(values)
            }
            Value::Map(id) => {
                let entries = {
                    let state = self.state();
                    let Heap::Map(entries) = &state.heap[*id] else {
                        return Err(Fault::data("Invalid Map."));
                    };
                    entries.clone()
                };
                Ok(entries
                    .into_iter()
                    .map(|(key, value)| self.state().array(vec![key, value]))
                    .collect())
            }
            Value::Set(id) => {
                let state = self.state();
                let Heap::Set { items, .. } = &state.heap[*id] else {
                    return Err(Fault::data("Invalid Set."));
                };
                Ok(items.iter().map(|(_, value)| value.clone()).collect())
            }
            Value::Params(id) => {
                let entries = {
                    let state = self.state();
                    let Heap::Params { entries, .. } = &state.heap[*id] else {
                        return Err(Fault::data("Invalid URLSearchParams."));
                    };
                    entries.clone()
                };
                Ok(entries
                    .into_iter()
                    .map(|(key, value)| {
                        self.state()
                            .array(vec![Value::String(key), Value::String(value)])
                    })
                    .collect())
            }
            _ => Err(Fault::error(
                "TypeError",
                "Expected an iterable collection.",
                location,
            )),
        }
    }

    fn delete<'a>(
        &'a self,
        expression: &'a Expression,
        scopes: &'a [usize],
        location: &'a Position,
    ) -> EvalFuture<'a, Value> {
        Box::pin(async move {
            let expression = match &expression.kind {
                ExpressionKind::Chain(value) => value.as_ref(),
                _ => expression,
            };
            let ExpressionKind::Member(object, key, optional) = &expression.kind else {
                return Err(Fault::error(
                    "TypeError",
                    "delete requires an object property or array index.",
                    location,
                ));
            };
            let object = self.evaluate(object, scopes).await?;
            if matches!(object, Value::ShortCircuit)
                || (*optional && matches!(object, Value::Null | Value::Undefined))
            {
                return Ok(Value::Boolean(true));
            }
            let key = self.evaluate(key, scopes).await?;
            let key = self.state().text(&key)?;
            self.require_key(&key, location)?;
            let mut state = self.state();
            match object {
                Value::RegExp(_) if key.as_str() == Some("lastIndex") => {
                    return Ok(Value::Boolean(false));
                }
                Value::Array(_) if key.as_str() == Some("length") => {
                    return Ok(Value::Boolean(false));
                }
                Value::Object(id) => {
                    let Heap::Object { fields, .. } = &mut state.heap[id] else {
                        return Err(Fault::data("Invalid object."));
                    };
                    fields.retain(|(name, _)| name != &key);
                }
                Value::Array(id) => {
                    let Heap::Array { items, fields, .. } = &mut state.heap[id] else {
                        return Err(Fault::data("Invalid array."));
                    };
                    if let Some(index) = index(&key) {
                        items.remove(&index);
                    } else {
                        fields.retain(|(name, _)| name != &key);
                    }
                }
                _ => {
                    return Err(Fault::data_at(
                        "Only data fields may be deleted in CodeMode.",
                        location,
                    ));
                }
            }
            Ok(Value::Boolean(true))
        })
    }

    fn binary(
        &self,
        operator: &str,
        left: Value,
        right: Value,
        location: &Position,
    ) -> Result<Value, Fault> {
        if operator == "instanceof" {
            return Ok(Value::Boolean(self.instance_of(&left, &right, location)?));
        }
        if operator == "in" {
            let key = self.state().text(&left)?;
            if !matches!(right, Value::Tool(_)) {
                self.require_key(&key, location)?;
            }
            if key.as_str() == Some("length") && matches!(right, Value::Array(_)) {
                return Ok(Value::Boolean(true));
            }
            return Ok(Value::Boolean(self.keys(&right, location)?.contains(&key)));
        }
        if ["===", "!=="].contains(&operator) {
            return Ok(Value::Boolean(
                identical(&left, &right, false) ^ (operator == "!=="),
            ));
        }
        if ["==", "!="].contains(&operator) {
            return Ok(Value::Boolean(
                self.loose_equal(left, right)? ^ (operator == "!="),
            ));
        }
        let state = self.state();
        let left = state.primitive(&left, operator == "+")?;
        let right = state.primitive(&right, operator == "+")?;
        if operator == "+"
            && (matches!(left, Value::String(_)) || matches!(right, Value::String(_)))
        {
            return Ok(Value::String(concat(&[
                state.text(&left)?,
                state.text(&right)?,
            ])));
        }
        if ["<", "<=", ">", ">="].contains(&operator) {
            let comparison = match (&left, &right) {
                (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
                _ => state.number(&left)?.partial_cmp(&state.number(&right)?),
            };
            return Ok(Value::Boolean(comparison.is_some_and(
                |comparison| match operator {
                    "<" => comparison.is_lt(),
                    "<=" => !comparison.is_gt(),
                    ">" => comparison.is_gt(),
                    _ => !comparison.is_lt(),
                },
            )));
        }
        let a = state.number(&left)?;
        let b = state.number(&right)?;
        Ok(Value::Number(match operator {
            "+" => a + b,
            "-" => a - b,
            "*" => a * b,
            "/" => a / b,
            "%" => a % b,
            "**" => a.powf(b),
            "&" => (int32(a) & int32(b)) as f64,
            "|" => (int32(a) | int32(b)) as f64,
            "^" => (int32(a) ^ int32(b)) as f64,
            "<<" => int32(a).wrapping_shl(uint32(b) & 31) as f64,
            ">>" => int32(a).wrapping_shr(uint32(b) & 31) as f64,
            ">>>" => uint32(a).wrapping_shr(uint32(b) & 31) as f64,
            _ => return Err(Fault::error("Error", "Unknown binary operator.", location)),
        }))
    }

    fn loose_equal(&self, a: Value, b: Value) -> Result<bool, Fault> {
        if identical(&a, &b, false) {
            return Ok(true);
        }
        if matches!(a, Value::Null | Value::Undefined)
            && matches!(b, Value::Null | Value::Undefined)
        {
            return Ok(true);
        }
        if matches!(a, Value::Null | Value::Undefined)
            || matches!(b, Value::Null | Value::Undefined)
        {
            return Ok(false);
        }
        if let Value::Boolean(value) = a {
            return self.loose_equal(Value::Number(if value { 1.0 } else { 0.0 }), b);
        }
        if let Value::Boolean(value) = b {
            return self.loose_equal(a, Value::Number(if value { 1.0 } else { 0.0 }));
        }
        if matches!(
            (&a, &b),
            (Value::Number(_), Value::String(_)) | (Value::String(_), Value::Number(_))
        ) {
            let state = self.state();
            return Ok(state.number(&a)? == state.number(&b)?);
        }
        if matches!(
            a,
            Value::Object(_)
                | Value::Array(_)
                | Value::Date(_)
                | Value::Map(_)
                | Value::Set(_)
                | Value::Url(_)
                | Value::Params(_)
        ) && matches!(b, Value::String(_) | Value::Number(_))
        {
            let a = self.state().primitive(&a, true)?;
            return self.loose_equal(a, b);
        }
        if matches!(
            b,
            Value::Object(_)
                | Value::Array(_)
                | Value::Date(_)
                | Value::Map(_)
                | Value::Set(_)
                | Value::Url(_)
                | Value::Params(_)
        ) && matches!(a, Value::String(_) | Value::Number(_))
        {
            let b = self.state().primitive(&b, true)?;
            return self.loose_equal(a, b);
        }
        Ok(false)
    }

    fn instance_of(&self, left: &Value, right: &Value, location: &Position) -> Result<bool, Fault> {
        let Value::Namespace(name) = right else {
            return Err(Fault::error(
                "TypeError",
                "The right-hand side of 'instanceof' must be a constructor CodeMode knows.",
                location,
            ));
        };
        Ok(match name.as_str() {
            "Object" => {
                matches!(
                    left,
                    Value::Object(_)
                        | Value::Array(_)
                        | Value::Date(_)
                        | Value::Map(_)
                        | Value::Set(_)
                        | Value::Url(_)
                        | Value::Params(_)
                        | Value::Promise(_)
                        | Value::RegExp(_)
                ) || type_of(left) == "function"
            }
            "Array" => matches!(left, Value::Array(_)),
            "Date" => matches!(left, Value::Date(_)),
            "Map" => matches!(left, Value::Map(_)),
            "Set" => matches!(left, Value::Set(_)),
            "URL" => matches!(left, Value::Url(_)),
            "URLSearchParams" => matches!(left, Value::Params(_)),
            "Promise" => matches!(left, Value::Promise(_)),
            "RegExp" => matches!(left, Value::RegExp(_)),
            "Number" | "String" | "Boolean" => false,
            name if name.ends_with("Error") => match left {
                Value::Object(id) => {
                    let state = self.state();
                    matches!(&state.heap[*id],Heap::Object {brand:Some(brand),..}if name=="Error"||brand==name)
                }
                _ => false,
            },
            _ => {
                return Err(Fault::error(
                    "TypeError",
                    "Unknown instanceof constructor.",
                    location,
                ));
            }
        })
    }

    pub fn thrown(&self, value: Value, location: &Position) -> Fault {
        let message = match &value {
            Value::String(value) => value
                .to_utf8()
                .unwrap_or_else(|_| "a non-data value".into()),
            Value::Object(_) => match self.get(&value, &"message".into(), location) {
                Ok(Value::String(message)) => message
                    .to_utf8()
                    .unwrap_or_else(|_| "a non-data value".into()),
                _ => self
                    .state()
                    .json(&value, true)
                    .ok()
                    .flatten()
                    .map(|value| ycoding_schema::stringify_json(&value))
                    .unwrap_or_else(|| "a non-data value".into()),
            },
            _ => self
                .state()
                .json(&value, true)
                .ok()
                .flatten()
                .map(|value| ycoding_schema::stringify_json(&value))
                .unwrap_or_else(|| "a non-data value".into()),
        };
        Fault {
            thrown: Some(value),
            message: format!("Uncaught: {message}"),
            ..Fault::error("Error", "", location)
        }
    }

    pub fn call<'a>(
        &'a self,
        callable: Value,
        arguments: Vec<Value>,
        construct: bool,
        location: &'a Position,
    ) -> EvalFuture<'a, Value> {
        Box::pin(async move {
            match callable {
                Value::Function(id) => {
                    if construct {
                        return Err(Fault::error(
                            "TypeError",
                            "User-defined constructor calls are not supported in CodeMode.",
                            location,
                        ));
                    }
                    let closure = {
                        let state = self.state();
                        let Heap::Function(closure) = &state.heap[id] else {
                            return Err(Fault::data("Invalid function."));
                        };
                        closure.clone()
                    };
                    if closure.function.asynchronous {
                        let vm = self.clone();
                        let location = location.clone();
                        return Ok(self.spawn(Box::pin(async move {
                            vm.invoke_function(closure, arguments, &location).await
                        })));
                    }
                    self.invoke_function(closure, arguments, location).await
                }
                Value::Namespace(name) => {
                    super::stdlib::namespace(self, &name, arguments, construct, location).await
                }
                Value::Intrinsic(receiver, name) => {
                    super::stdlib::method(self, *receiver, &name, arguments, location).await
                }
                Value::Tool(path) => self.tool(path, arguments, location),
                Value::Resolver(id, reject) => {
                    let value = arguments.first().cloned().unwrap_or(Value::Undefined);
                    self.resolve(
                        id,
                        if reject {
                            Err(self.thrown(value, location))
                        } else {
                            Ok(value)
                        },
                    );
                    Ok(Value::Undefined)
                }
                _ => Err(Fault::error(
                    "TypeError",
                    "The called value is not a function.",
                    location,
                )),
            }
        })
    }

    async fn invoke_function(
        &self,
        closure: Closure,
        arguments: Vec<Value>,
        location: &Position,
    ) -> Result<Value, Fault> {
        let scopes = self.scope(&closure.scopes);
        for pattern in &closure.function.parameters {
            self.declare(&scopes, pattern, true)
        }
        if let Some(pattern) = &closure.function.rest {
            self.declare(&scopes, pattern, true)
        }
        if let Some(name) = &closure.function.name {
            let value = Value::Function(self.state().allocate(Heap::Function(closure.clone())));
            self.assign_identifier(&scopes, name, value, Some(false), location)?;
        }
        for (index, pattern) in closure.function.parameters.iter().enumerate() {
            self.bind(
                pattern,
                arguments.get(index).cloned().unwrap_or(Value::Undefined),
                &scopes,
                Some(true),
                location,
            )
            .await?;
        }
        if let Some(pattern) = &closure.function.rest {
            let value = self.state().array(
                arguments
                    .into_iter()
                    .skip(closure.function.parameters.len())
                    .collect(),
            );
            self.bind(pattern, value, &scopes, Some(true), location)
                .await?;
        }
        let value = match self.body(&closure.function.body, &scopes, false).await? {
            Flow::Return(value) => value,
            Flow::Normal => Value::Undefined,
            Flow::Break | Flow::Continue => {
                return Err(Fault::error(
                    "Error",
                    "Unexpected loop control outside of a loop.",
                    location,
                ));
            }
        };
        Ok(value)
    }

    pub async fn callback(
        &self,
        callable: Value,
        arguments: Vec<Value>,
        name: &str,
        location: &Position,
    ) -> Result<Value, Fault> {
        self.validate_callback(&callable, name, location)?;
        self.call(callable, arguments, false, location).await
    }

    pub fn validate_callback(
        &self,
        callable: &Value,
        name: &str,
        location: &Position,
    ) -> Result<(), Fault> {
        if matches!(callable, Value::Tool(_))
            || matches!(callable,Value::Intrinsic(receiver,_)if matches!(receiver.as_ref(),Value::Namespace(namespace)if namespace=="Promise"))
        {
            return Err(Fault::error(
                "TypeError",
                format!(
                    "{name} cannot use this callable as a callback; wrap it in an arrow function, e.g. (value) => tools.ns.tool(value)."
                ),
                location,
            ));
        }
        if type_of(callable) != "function" && !matches!(callable, Value::Namespace(_)) {
            return Err(Fault::error(
                "TypeError",
                format!("{name} expects a function callback."),
                location,
            ));
        }
        Ok(())
    }

    pub async fn numeric_argument(&self, value: Value, location: &Position) -> Result<f64, Fault> {
        if !matches!(value, Value::Object(_)) {
            return self.state().number(&value);
        }
        let primitive = self.date_primitive(value, location).await?;
        self.state().number(&primitive)
    }

    pub async fn date_primitive(&self, value: Value, location: &Position) -> Result<Value, Fault> {
        if !matches!(value, Value::Object(_)) {
            return match value {
                Value::Undefined
                | Value::Null
                | Value::Boolean(_)
                | Value::Number(_)
                | Value::String(_) => Ok(value),
                _ => Ok(Value::String(self.state().text(&value)?)),
            };
        }
        let value_of = self.get(&value, &"valueOf".into(), location)?;
        if type_of(&value_of) == "function" {
            let result = self.call(value_of, Vec::new(), false, location).await?;
            if matches!(
                result,
                Value::Undefined
                    | Value::Null
                    | Value::Boolean(_)
                    | Value::Number(_)
                    | Value::String(_)
            ) {
                return Ok(result);
            }
        }
        let to_string = self.get(&value, &"toString".into(), location)?;
        if matches!(to_string, Value::Undefined) {
            return Ok(Value::String(self.state().text(&value)?));
        }
        if type_of(&to_string) == "function" {
            let result = self.call(to_string, Vec::new(), false, location).await?;
            if matches!(
                result,
                Value::Undefined
                    | Value::Null
                    | Value::Boolean(_)
                    | Value::Number(_)
                    | Value::String(_)
            ) {
                return Ok(result);
            }
        }
        Err(Fault::error(
            "TypeError",
            "Cannot convert object to primitive value.",
            location,
        ))
    }

    fn tool(
        &self,
        path: Vec<LosslessString>,
        arguments: Vec<Value>,
        location: &Position,
    ) -> Result<Value, Fault> {
        let name = super::stdlib::discovery::joined(&path);
        let label = super::stdlib::discovery::display(&name);
        if !self.host.catalog().iter().any(|tool| tool.path == name) {
            let message = if self
                .host
                .catalog()
                .iter()
                .any(|tool| super::stdlib::discovery::segments(&tool.path).starts_with(&path))
            {
                format!("Tool '{label}' is not callable.")
            } else {
                format!("Unknown tool '{label}'.")
            };
            return Err(Fault {
                kind: DiagnosticKind::UnknownTool,
                ..Fault::error("Error", message, location)
            });
        }
        if arguments.len() != 1 {
            return Err(Fault {
                kind: DiagnosticKind::InvalidToolInput,
                ..Fault::error(
                    "Error",
                    format!("Tool '{label}' expects exactly one input object."),
                    location,
                )
            });
        }
        let input = self.state().json(&arguments[0], true)?;
        let input = self
            .host
            .decode_input(&name, input)
            .map_err(|failure| self.tool_fault(&name, failure, location))?;
        let index = {
            let mut state = self.state();
            if self
                .limits
                .max_tool_calls
                .is_some_and(|limit| state.calls.len() as u64 >= limit)
            {
                return Err(Fault {
                    kind: DiagnosticKind::ToolCallLimitExceeded,
                    ..Fault::error(
                        "Error",
                        format!(
                            "Execution exceeded its tool-call limit of {}.",
                            self.limits.max_tool_calls.unwrap_or(0)
                        ),
                        location,
                    )
                });
            }
            state.calls.push(name.clone());
            state.calls.len() - 1
        };
        let vm = self.clone();
        let location = location.clone();
        Ok(self.spawn(Box::pin(async move {
            let call = super::ToolCallStarted {
                index,
                name: name.clone(),
                input: input.clone(),
            };
            vm.host.on_tool_call_start(call.clone()).await;
            let started = std::time::Instant::now();
            let result: Result<Value, Fault> = async {
                let output = vm
                    .host
                    .invoke(name.clone(), input, vm.work_cancel.clone())
                    .await
                    .map_err(|failure| vm.tool_fault(&name, failure, &location))?;
                let output = vm
                    .host
                    .decode_output(&name, output)
                    .map_err(|failure| vm.tool_fault(&name, failure, &location))?;
                let value = output
                    .map(|output| vm.state().decode_json(output))
                    .unwrap_or(Value::Undefined);
                vm.state().json(&value, false).map_err(|_| {
                    vm.tool_fault(&name, super::ToolFailure::InvalidOutput, &location)
                })?;
                Ok(value)
            }
            .await;
            let outcome = match &result {
                Ok(_) => Some(super::ToolCallOutcome::Success),
                Err(fault) if !fault.fatal => {
                    Some(super::ToolCallOutcome::Failure(fault.message.clone()))
                }
                _ => None,
            };
            if let Some(outcome) = outcome {
                vm.host
                    .on_tool_call_end(super::ToolCallEnded {
                        call,
                        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        outcome,
                    })
                    .await;
            }
            result
        })))
    }

    pub fn tool_fault(
        &self,
        name: &LosslessString,
        failure: super::ToolFailure,
        location: &Position,
    ) -> Fault {
        let name = super::stdlib::discovery::display(name);
        let (kind, message) = match failure {
            super::ToolFailure::Safe(message) => (DiagnosticKind::ToolFailure, message),
            super::ToolFailure::Internal => {
                (DiagnosticKind::ToolFailure, "Tool execution failed".into())
            }
            super::ToolFailure::InvalidInput(message) => (
                DiagnosticKind::InvalidToolInput,
                format!("Invalid input for tool '{name}': {message}"),
            ),
            super::ToolFailure::InvalidOutput => (
                DiagnosticKind::InvalidToolOutput,
                format!("Invalid output from tool '{name}'."),
            ),
            super::ToolFailure::Cancelled => return self.interrupted(location),
        };
        Fault {
            kind,
            ..Fault::error("Error", message, location)
        }
    }

    pub fn construct_regexp(
        &self,
        pattern: &LosslessString,
        flags: &str,
        location: &Position,
    ) -> Result<Value, Fault> {
        let pattern = super::regexp::compile(self, pattern, flags, location)?;
        Ok(Value::RegExp(self.state().allocate(Heap::RegExp {
            pattern,
            last_index: Value::Number(0.0),
        })))
    }
}

fn pattern_names(pattern: &Pattern, out: &mut Vec<String>) {
    match pattern {
        Pattern::Identifier(name) => out.push(name.clone()),
        Pattern::Default(pattern, _) => pattern_names(pattern, out),
        Pattern::Array(patterns, rest) => {
            for pattern in patterns.iter().flatten() {
                pattern_names(pattern, out)
            }
            if let Some(rest) = rest {
                pattern_names(rest, out)
            }
        }
        Pattern::Object(patterns, rest) => {
            for (_, pattern) in patterns {
                pattern_names(pattern, out)
            }
            if let Some(rest) = rest {
                pattern_names(rest, out)
            }
        }
        Pattern::Member(_, _) => {}
    }
}
