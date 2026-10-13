use oxc_allocator::Allocator;
use oxc_ast::ast;
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::{GetSpan, SourceType, Span};
use ycoding_schema::LosslessString;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiagnosticKind {
    ParseError,
    UnsupportedSyntax,
    UnknownTool,
    InvalidToolInput,
    InvalidToolOutput,
    InvalidDataValue,
    ToolCallLimitExceeded,
    TimeoutExceeded,
    ToolFailure,
    ExecutionFailure,
    Truncated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub index: usize,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub kind: DiagnosticKind,
    pub message: String,
    pub location: Position,
}

#[derive(Clone, Debug)]
pub struct Program {
    source: LosslessString,
    pub(crate) body: Vec<Statement>,
}

#[derive(Clone, Debug)]
pub(crate) struct Expression {
    pub location: Position,
    pub kind: ExpressionKind,
}

#[derive(Clone, Debug)]
pub(crate) enum ExpressionKind {
    Null,
    Boolean(bool),
    Number(f64),
    String(LosslessString),
    Identifier(String),
    Array(Vec<Option<Argument>>),
    Object(Vec<Property>),
    Template(Vec<LosslessString>, Vec<Expression>),
    RegExp(LosslessString, String),
    Function(Function),
    Member(Box<Expression>, Box<Expression>, bool),
    Call(Box<Expression>, Vec<Argument>, bool, bool),
    Unary(String, Box<Expression>),
    Binary(String, Box<Expression>, Box<Expression>),
    Logical(String, Box<Expression>, Box<Expression>),
    Conditional(Box<Expression>, Box<Expression>, Box<Expression>),
    Assign(String, Pattern, Box<Expression>),
    Update(String, Pattern, bool),
    Sequence(Vec<Expression>),
    Await(Box<Expression>),
    Chain(Box<Expression>),
}

#[derive(Clone, Debug)]
pub(crate) struct Argument {
    pub value: Expression,
    pub spread: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum Property {
    Field(Expression, Expression),
    Spread(Expression),
}

#[derive(Clone, Debug)]
pub(crate) struct Function {
    pub name: Option<String>,
    pub parameters: Vec<Pattern>,
    pub rest: Option<Box<Pattern>>,
    pub body: Vec<Statement>,
    pub asynchronous: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum Pattern {
    Identifier(String),
    Member(Box<Expression>, Box<Expression>),
    Default(Box<Pattern>, Box<Expression>),
    Array(Vec<Option<Pattern>>, Option<Box<Pattern>>),
    Object(Vec<(Expression, Pattern)>, Option<Box<Pattern>>),
}

#[derive(Clone, Debug)]
pub(crate) struct Declaration {
    pub pattern: Pattern,
    pub value: Option<Expression>,
    pub mutable: bool,
    pub lexical: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Statement {
    pub location: Position,
    pub kind: StatementKind,
}

#[derive(Clone, Debug)]
pub(crate) enum StatementKind {
    Empty,
    Expression(Expression),
    Declare(Vec<Declaration>),
    Function(Function),
    Block(Vec<Statement>),
    Return(Option<Expression>),
    If(Expression, Box<Statement>, Option<Box<Statement>>),
    While(Expression, Box<Statement>, bool),
    For(
        Option<Box<Statement>>,
        Option<Expression>,
        Option<Expression>,
        Box<Statement>,
    ),
    Iterate(
        Option<Declaration>,
        Pattern,
        Expression,
        Box<Statement>,
        bool,
    ),
    Break,
    Continue,
    Switch(Expression, Vec<(Option<Expression>, Vec<Statement>)>),
    Throw(Expression),
    Try(
        Vec<Statement>,
        Option<(Option<Pattern>, Vec<Statement>)>,
        Option<Vec<Statement>>,
    ),
}

impl Program {
    pub fn parse(source: impl Into<LosslessString>) -> Result<Self, Vec<Diagnostic>> {
        let original = source.into();
        let units = original.code_units().collect::<Vec<_>>();
        let normalized = String::from_utf16_lossy(&units);
        let prefix = "async function __codemode__(){\n";
        let source = format!("{prefix}{normalized}\n}}");
        let source = source.as_str();
        let wrapped = prefix
            .encode_utf16()
            .chain(units.iter().copied())
            .chain("\n}".encode_utf16())
            .collect::<Vec<_>>();
        let arena = Allocator::default();
        let parsed = Parser::new(&arena, source, SourceType::ts().with_script(true)).parse();
        let semantic = SemanticBuilder::new()
            .with_check_syntax_error(true)
            .build(&parsed.program);
        let diagnostics = parsed
            .diagnostics
            .iter()
            .chain(semantic.diagnostics.iter())
            .map(|item| Diagnostic {
                kind: DiagnosticKind::ParseError,
                message: item.message.to_string(),
                location: position(
                    &normalized,
                    item.labels
                        .first()
                        .map_or(0, |label| label.offset() as usize)
                        .saturating_sub(prefix.len())
                        .min(normalized.len()),
                ),
            })
            .collect::<Vec<_>>();
        if !diagnostics.is_empty() {
            return Err(diagnostics);
        }
        let lower = Lower {
            source,
            original: &wrapped,
            origin: &normalized,
            prefix_bytes: prefix.len(),
            scoping: semantic.semantic.scoping(),
        };
        let Some(ast::Statement::FunctionDeclaration(function)) = parsed.program.body.first()
        else {
            unreachable!("The parsed execution wrapper is a function")
        };
        let body = lower
            .statements(
                &function
                    .body
                    .as_ref()
                    .expect("The execution wrapper has a body")
                    .statements,
            )
            .map_err(|error| vec![error])?;
        Ok(Self {
            source: original,
            body,
        })
    }

    pub fn source(&self) -> &LosslessString {
        &self.source
    }
}

pub(crate) fn position(source: &str, offset: usize) -> Position {
    let prefix = &source[..offset.min(source.len())];
    let (line, column, _) =
        prefix.chars().fold(
            (1, 0, false),
            |(line, column, cr), character| match character {
                '\r' => (line + 1, 0, true),
                '\n' => (line + usize::from(!cr), 0, false),
                '\u{2028}' | '\u{2029}' => (line + 1, 0, false),
                character => (line, column + character.len_utf16(), false),
            },
        );
    Position {
        index: prefix.encode_utf16().count(),
        line,
        column,
    }
}

struct Lower<'a> {
    source: &'a str,
    original: &'a [u16],
    origin: &'a str,
    prefix_bytes: usize,
    scoping: &'a Scoping,
}

impl Lower<'_> {
    fn location(&self, offset: usize) -> Position {
        position(
            self.origin,
            offset
                .saturating_sub(self.prefix_bytes)
                .min(self.origin.len()),
        )
    }

    fn unsupported(&self, name: &str, span: Span) -> Diagnostic {
        Diagnostic {
            kind: DiagnosticKind::UnsupportedSyntax,
            message: format!("Syntax '{name}' is not supported in CodeMode."),
            location: self.location(span.start as usize),
        }
    }

    fn statements(&self, nodes: &[ast::Statement<'_>]) -> Result<Vec<Statement>, Diagnostic> {
        nodes.iter().map(|node| self.statement(node)).collect()
    }

    fn statement(&self, node: &ast::Statement<'_>) -> Result<Statement, Diagnostic> {
        let kind = match node {
            ast::Statement::EmptyStatement(_)
            | ast::Statement::TSTypeAliasDeclaration(_)
            | ast::Statement::TSInterfaceDeclaration(_) => StatementKind::Empty,
            ast::Statement::ExpressionStatement(item) => {
                StatementKind::Expression(self.expression(&item.expression)?)
            }
            ast::Statement::VariableDeclaration(item) => {
                if item.declare {
                    StatementKind::Empty
                } else {
                    StatementKind::Declare(self.declarations(item)?)
                }
            }
            ast::Statement::FunctionDeclaration(item) => {
                if item.declare || item.body.is_none() {
                    StatementKind::Empty
                } else {
                    StatementKind::Function(self.function(item)?)
                }
            }
            ast::Statement::BlockStatement(item) => {
                StatementKind::Block(self.statements(&item.body)?)
            }
            ast::Statement::ReturnStatement(item) => StatementKind::Return(
                item.argument
                    .as_ref()
                    .map(|value| self.expression(value))
                    .transpose()?,
            ),
            ast::Statement::IfStatement(item) => StatementKind::If(
                self.expression(&item.test)?,
                Box::new(self.statement(&item.consequent)?),
                item.alternate
                    .as_ref()
                    .map(|body| self.statement(body).map(Box::new))
                    .transpose()?,
            ),
            ast::Statement::WhileStatement(item) => StatementKind::While(
                self.expression(&item.test)?,
                Box::new(self.statement(&item.body)?),
                false,
            ),
            ast::Statement::DoWhileStatement(item) => StatementKind::While(
                self.expression(&item.test)?,
                Box::new(self.statement(&item.body)?),
                true,
            ),
            ast::Statement::ForStatement(item) => {
                let init = item
                    .init
                    .as_ref()
                    .map(|init| match init {
                        ast::ForStatementInit::VariableDeclaration(value) => Ok(Statement {
                            location: self.location(value.span.start as usize),
                            kind: StatementKind::Declare(self.declarations(value)?),
                        }),
                        value => self
                            .expression(value.to_expression())
                            .map(|value| Statement {
                                location: value.location.clone(),
                                kind: StatementKind::Expression(value),
                            }),
                    })
                    .transpose()?
                    .map(Box::new);
                StatementKind::For(
                    init,
                    item.test
                        .as_ref()
                        .map(|value| self.expression(value))
                        .transpose()?,
                    item.update
                        .as_ref()
                        .map(|value| self.expression(value))
                        .transpose()?,
                    Box::new(self.statement(&item.body)?),
                )
            }
            ast::Statement::ForInStatement(item) => {
                let (declaration, pattern) = self.loop_left(&item.left)?;
                StatementKind::Iterate(
                    declaration,
                    pattern,
                    self.expression(&item.right)?,
                    Box::new(self.statement(&item.body)?),
                    true,
                )
            }
            ast::Statement::ForOfStatement(item) => {
                if item.r#await {
                    return Err(self.unsupported("ForAwaitOfStatement", item.span));
                }
                let (declaration, pattern) = self.loop_left(&item.left)?;
                StatementKind::Iterate(
                    declaration,
                    pattern,
                    self.expression(&item.right)?,
                    Box::new(self.statement(&item.body)?),
                    false,
                )
            }
            ast::Statement::BreakStatement(item) => {
                if item.label.is_some() {
                    return Err(self.unsupported("LabeledBreakStatement", item.span));
                }
                StatementKind::Break
            }
            ast::Statement::ContinueStatement(item) => {
                if item.label.is_some() {
                    return Err(self.unsupported("LabeledContinueStatement", item.span));
                }
                StatementKind::Continue
            }
            ast::Statement::SwitchStatement(item) => StatementKind::Switch(
                self.expression(&item.discriminant)?,
                item.cases
                    .iter()
                    .map(|case| {
                        Ok((
                            case.test
                                .as_ref()
                                .map(|value| self.expression(value))
                                .transpose()?,
                            self.statements(&case.consequent)?,
                        ))
                    })
                    .collect::<Result<_, Diagnostic>>()?,
            ),
            ast::Statement::ThrowStatement(item) => {
                StatementKind::Throw(self.expression(&item.argument)?)
            }
            ast::Statement::TryStatement(item) => StatementKind::Try(
                self.statements(&item.block.body)?,
                item.handler
                    .as_ref()
                    .map(|handler| {
                        Ok((
                            handler
                                .param
                                .as_ref()
                                .map(|parameter| self.pattern(&parameter.pattern))
                                .transpose()?,
                            self.statements(&handler.body.body)?,
                        ))
                    })
                    .transpose()?,
                item.finalizer
                    .as_ref()
                    .map(|body| self.statements(&body.body))
                    .transpose()?,
            ),
            ast::Statement::ClassDeclaration(_) => {
                return Err(self.unsupported("ClassDeclaration", node.span()));
            }
            ast::Statement::ImportDeclaration(_) | ast::Statement::TSImportEqualsDeclaration(_) => {
                return Err(Diagnostic {
                    kind: DiagnosticKind::ParseError,
                    message: "'import' and 'export' may appear only with 'sourceType: module'"
                        .into(),
                    location: self.location(node.span().start as usize),
                });
            }
            ast::Statement::DebuggerStatement(_)
            | ast::Statement::LabeledStatement(_)
            | ast::Statement::WithStatement(_)
            | ast::Statement::TSEnumDeclaration(_)
            | ast::Statement::TSExternalModuleDeclaration(_)
            | ast::Statement::TSNamespaceDeclaration(_)
            | ast::Statement::TSGlobalDeclaration(_)
            | ast::Statement::ExportAllDeclaration(_)
            | ast::Statement::ExportDefaultDeclaration(_)
            | ast::Statement::ExportDeclaration(_)
            | ast::Statement::ExportNamedDeclaration(_)
            | ast::Statement::ExportFromDeclaration(_)
            | ast::Statement::TSExportAssignment(_)
            | ast::Statement::TSNamespaceExportDeclaration(_) => {
                return Err(self.unsupported("Statement", node.span()));
            }
        };
        Ok(Statement {
            location: self.location(node.span().start as usize),
            kind,
        })
    }

    fn declarations(
        &self,
        node: &ast::VariableDeclaration<'_>,
    ) -> Result<Vec<Declaration>, Diagnostic> {
        let (mutable, lexical) = match node.kind {
            ast::VariableDeclarationKind::Const => (false, true),
            ast::VariableDeclarationKind::Let => (true, true),
            ast::VariableDeclarationKind::Var => (true, false),
            ast::VariableDeclarationKind::Using | ast::VariableDeclarationKind::AwaitUsing => {
                return Err(self.unsupported("UsingDeclaration", node.span));
            }
        };
        node.declarations
            .iter()
            .map(|item| {
                Ok(Declaration {
                    pattern: self.pattern(&item.id)?,
                    value: item
                        .init
                        .as_ref()
                        .map(|value| self.expression(value))
                        .transpose()?,
                    mutable,
                    lexical,
                })
            })
            .collect()
    }

    fn loop_left(
        &self,
        node: &ast::ForStatementLeft<'_>,
    ) -> Result<(Option<Declaration>, Pattern), Diagnostic> {
        if let ast::ForStatementLeft::VariableDeclaration(value) = node {
            let declaration = self
                .declarations(value)?
                .into_iter()
                .next()
                .ok_or_else(|| self.unsupported("EmptyLoopBinding", value.span))?;
            return Ok((Some(declaration.clone()), declaration.pattern));
        }
        Ok((None, self.target(node.to_assignment_target())?))
    }

    fn expression(&self, node: &ast::Expression<'_>) -> Result<Expression, Diagnostic> {
        let kind = match node {
            ast::Expression::NullLiteral(_) => ExpressionKind::Null,
            ast::Expression::BooleanLiteral(item) => ExpressionKind::Boolean(item.value),
            ast::Expression::NumericLiteral(item) => ExpressionKind::Number(item.value),
            ast::Expression::StringLiteral(item) => {
                let raw = self.raw(item.span);
                let mut index = 1;
                while index + 1 < raw.len() {
                    if raw[index] != 92 {
                        index += 1;
                        continue;
                    }
                    let escaped = raw[index + 1];
                    if (49..=57).contains(&escaped)
                        || escaped == 48
                            && raw
                                .get(index + 2)
                                .is_some_and(|unit| (48..=57).contains(unit))
                    {
                        return Err(Diagnostic { kind: DiagnosticKind::ParseError, message: "Failed to parse TypeScript: Legacy octal escape sequences are not allowed.".into(), location: self.location(item.span.start as usize) });
                    }
                    index += 2;
                }
                ExpressionKind::String(decode_literal(&raw[1..raw.len() - 1], false))
            }
            ast::Expression::Identifier(item) => {
                if item
                    .reference_id
                    .get()
                    .is_some_and(|id| self.scoping.get_reference(id).symbol_id().is_none())
                    && [
                        "eval",
                        "Function",
                        "globalThis",
                        "global",
                        "process",
                        "require",
                        "fetch",
                        "Bun",
                        "Deno",
                        "window",
                        "document",
                        "setTimeout",
                        "setInterval",
                        "queueMicrotask",
                        "WebAssembly",
                    ]
                    .contains(&item.name.as_str())
                {
                    return Err(self.unsupported(item.name.as_str(), item.span));
                }
                ExpressionKind::Identifier(item.name.to_string())
            }
            ast::Expression::ArrayExpression(item) => ExpressionKind::Array(
                item.elements
                    .iter()
                    .map(|value| match value {
                        ast::ArrayExpressionElement::Elision(_) => Ok(None),
                        ast::ArrayExpressionElement::SpreadElement(value) => Ok(Some(Argument {
                            value: self.expression(&value.argument)?,
                            spread: true,
                        })),
                        value => Ok(Some(Argument {
                            value: self.expression(value.to_expression())?,
                            spread: false,
                        })),
                    })
                    .collect::<Result<_, Diagnostic>>()?,
            ),
            ast::Expression::ObjectExpression(item) => ExpressionKind::Object(
                item.properties
                    .iter()
                    .map(|property| match property {
                        ast::ObjectPropertyKind::SpreadProperty(value) => {
                            self.expression(&value.argument).map(Property::Spread)
                        }
                        ast::ObjectPropertyKind::ObjectProperty(value) => {
                            if value.kind != ast::PropertyKind::Init {
                                return Err(self.unsupported("AccessorProperty", value.span));
                            }
                            Ok(Property::Field(
                                self.key(&value.key, value.computed)?,
                                self.expression(&value.value)?,
                            ))
                        }
                    })
                    .collect::<Result<_, Diagnostic>>()?,
            ),
            ast::Expression::TemplateLiteral(item) => ExpressionKind::Template(
                item.quasis
                    .iter()
                    .map(|quasi| decode_literal(self.raw(quasi.span), true))
                    .collect(),
                item.expressions
                    .iter()
                    .map(|value| self.expression(value))
                    .collect::<Result<_, _>>()?,
            ),
            ast::Expression::RegExpLiteral(item) => {
                let raw = self.raw(item.span);
                let end = raw
                    .iter()
                    .rposition(|unit| *unit == u16::from(b'/'))
                    .expect("A parsed RegExp literal has a closing delimiter");
                ExpressionKind::RegExp(
                    LosslessString::from_utf16(raw[1..end].to_vec()),
                    item.regex.flags.to_string(),
                )
            }
            ast::Expression::FunctionExpression(item) => {
                ExpressionKind::Function(self.function(item)?)
            }
            ast::Expression::ArrowFunctionExpression(item) => {
                let (parameters, rest) = self.parameters(&item.params)?;
                let body = match &item.body {
                    ast::ArrowFunctionBody::FunctionBody(body) => {
                        self.statements(&body.statements)?
                    }
                    value => {
                        let expression = self.expression(value.to_expression())?;
                        vec![Statement {
                            location: expression.location.clone(),
                            kind: StatementKind::Return(Some(expression)),
                        }]
                    }
                };
                ExpressionKind::Function(Function {
                    name: None,
                    parameters,
                    rest,
                    body,
                    asynchronous: item.r#async,
                })
            }
            ast::Expression::StaticMemberExpression(item) => {
                let key = self.string_key(item.property.name.as_str(), item.property.span);
                let object = self.expression(&item.object)?;
                self.check_member(&object, &key, item.span)?;
                ExpressionKind::Member(Box::new(object), Box::new(key), item.optional)
            }
            ast::Expression::ComputedMemberExpression(item) => {
                let object = self.expression(&item.object)?;
                let key = self.expression(&item.expression)?;
                self.check_member(&object, &key, item.span)?;
                ExpressionKind::Member(Box::new(object), Box::new(key), item.optional)
            }
            ast::Expression::CallExpression(item) => ExpressionKind::Call(
                Box::new(self.expression(&item.callee)?),
                self.arguments(&item.arguments)?,
                item.optional,
                false,
            ),
            ast::Expression::NewExpression(item) => ExpressionKind::Call(
                Box::new(self.expression(&item.callee)?),
                self.arguments(&item.arguments)?,
                false,
                true,
            ),
            ast::Expression::UnaryExpression(item) => ExpressionKind::Unary(
                item.operator.as_str().to_owned(),
                Box::new(self.expression(&item.argument)?),
            ),
            ast::Expression::BinaryExpression(item) => ExpressionKind::Binary(
                item.operator.as_str().to_owned(),
                Box::new(self.expression(&item.left)?),
                Box::new(self.expression(&item.right)?),
            ),
            ast::Expression::LogicalExpression(item) => ExpressionKind::Logical(
                item.operator.as_str().to_owned(),
                Box::new(self.expression(&item.left)?),
                Box::new(self.expression(&item.right)?),
            ),
            ast::Expression::ConditionalExpression(item) => ExpressionKind::Conditional(
                Box::new(self.expression(&item.test)?),
                Box::new(self.expression(&item.consequent)?),
                Box::new(self.expression(&item.alternate)?),
            ),
            ast::Expression::AssignmentExpression(item) => ExpressionKind::Assign(
                item.operator.as_str().to_owned(),
                self.target(&item.left)?,
                Box::new(self.expression(&item.right)?),
            ),
            ast::Expression::UpdateExpression(item) => ExpressionKind::Update(
                item.operator.as_str().to_owned(),
                self.simple_target(&item.argument)?,
                item.prefix,
            ),
            ast::Expression::SequenceExpression(item) => ExpressionKind::Sequence(
                item.expressions
                    .iter()
                    .map(|value| self.expression(value))
                    .collect::<Result<_, _>>()?,
            ),
            ast::Expression::AwaitExpression(item) => {
                ExpressionKind::Await(Box::new(self.expression(&item.argument)?))
            }
            ast::Expression::ParenthesizedExpression(item) => {
                return self.expression(&item.expression);
            }
            ast::Expression::TSAsExpression(item) => return self.expression(&item.expression),
            ast::Expression::TSSatisfiesExpression(item) => {
                return self.expression(&item.expression);
            }
            ast::Expression::TSTypeAssertion(item) => return self.expression(&item.expression),
            ast::Expression::TSNonNullExpression(item) => return self.expression(&item.expression),
            ast::Expression::TSInstantiationExpression(item) => {
                return self.expression(&item.expression);
            }
            ast::Expression::ChainExpression(item) => ExpressionKind::Chain(Box::new(match &item
                .expression
            {
                ast::ChainElement::CallExpression(value) => Expression {
                    location: self.location(value.span.start as usize),
                    kind: ExpressionKind::Call(
                        Box::new(self.expression(&value.callee)?),
                        self.arguments(&value.arguments)?,
                        value.optional,
                        false,
                    ),
                },
                ast::ChainElement::StaticMemberExpression(value) => {
                    let object = self.expression(&value.object)?;
                    let key = self.string_key(value.property.name.as_str(), value.property.span);
                    self.check_member(&object, &key, value.span)?;
                    Expression {
                        location: self.location(value.span.start as usize),
                        kind: ExpressionKind::Member(
                            Box::new(object),
                            Box::new(key),
                            value.optional,
                        ),
                    }
                }
                ast::ChainElement::ComputedMemberExpression(value) => {
                    let object = self.expression(&value.object)?;
                    let key = self.expression(&value.expression)?;
                    self.check_member(&object, &key, value.span)?;
                    Expression {
                        location: self.location(value.span.start as usize),
                        kind: ExpressionKind::Member(
                            Box::new(object),
                            Box::new(key),
                            value.optional,
                        ),
                    }
                }
                ast::ChainElement::TSNonNullExpression(value) => {
                    self.expression(&value.expression)?
                }
                ast::ChainElement::PrivateFieldExpression(_) => {
                    return Err(self.unsupported("PrivateFieldExpression", node.span()));
                }
            })),
            ast::Expression::BigIntLiteral(_)
            | ast::Expression::ClassExpression(_)
            | ast::Expression::ImportExpression(_)
            | ast::Expression::Super(_)
            | ast::Expression::TaggedTemplateExpression(_)
            | ast::Expression::ThisExpression(_)
            | ast::Expression::YieldExpression(_)
            | ast::Expression::PrivateInExpression(_)
            | ast::Expression::ImportMeta(_)
            | ast::Expression::NewTarget(_)
            | ast::Expression::JSXElement(_)
            | ast::Expression::JSXFragment(_)
            | ast::Expression::V8IntrinsicExpression(_)
            | ast::Expression::PrivateFieldExpression(_) => {
                return Err(self.unsupported("Expression", node.span()));
            }
        };
        Ok(Expression {
            location: self.location(node.span().start as usize),
            kind,
        })
    }

    fn key(&self, key: &ast::PropertyKey<'_>, computed: bool) -> Result<Expression, Diagnostic> {
        if let ast::PropertyKey::StaticIdentifier(value) = key {
            return Ok(self.string_key(value.name.as_str(), value.span));
        }
        if let ast::PropertyKey::PrivateIdentifier(value) = key {
            return Err(self.unsupported("PrivateIdentifier", value.span));
        }
        let value = self.expression(key.to_expression())?;
        let _ = computed;
        Ok(value)
    }

    fn string_key(&self, key: &str, span: Span) -> Expression {
        Expression {
            location: self.location(span.start as usize),
            kind: ExpressionKind::String(key.into()),
        }
    }

    fn raw(&self, span: Span) -> &[u16] {
        &self.original[self.source[..span.start as usize].encode_utf16().count()
            ..self.source[..span.end as usize].encode_utf16().count()]
    }

    fn check_member(
        &self,
        object: &Expression,
        key: &Expression,
        span: Span,
    ) -> Result<(), Diagnostic> {
        if let ExpressionKind::String(key) = &key.kind
            && blocked(key)
            && matches!(
                object.kind,
                ExpressionKind::Null
                    | ExpressionKind::Boolean(_)
                    | ExpressionKind::Number(_)
                    | ExpressionKind::String(_)
                    | ExpressionKind::Array(_)
                    | ExpressionKind::Object(_)
                    | ExpressionKind::Function(_)
            )
        {
            return Err(self.unsupported("BlockedProperty", span));
        }
        Ok(())
    }

    fn arguments(&self, nodes: &[ast::Argument<'_>]) -> Result<Vec<Argument>, Diagnostic> {
        nodes
            .iter()
            .map(|node| match node {
                ast::Argument::SpreadElement(value) => Ok(Argument {
                    value: self.expression(&value.argument)?,
                    spread: true,
                }),
                value => Ok(Argument {
                    value: self.expression(value.to_expression())?,
                    spread: false,
                }),
            })
            .collect()
    }

    fn function(&self, node: &ast::Function<'_>) -> Result<Function, Diagnostic> {
        if node.generator {
            return Err(self.unsupported("GeneratorFunction", node.span));
        }
        let (parameters, rest) = self.parameters(&node.params)?;
        let body = node
            .body
            .as_ref()
            .ok_or_else(|| self.unsupported("FunctionWithoutBody", node.span))?;
        Ok(Function {
            name: node.id.as_ref().map(|id| id.name.to_string()),
            parameters,
            rest,
            body: self.statements(&body.statements)?,
            asynchronous: node.r#async,
        })
    }

    fn parameters(
        &self,
        node: &ast::FormalParameters<'_>,
    ) -> Result<(Vec<Pattern>, Option<Box<Pattern>>), Diagnostic> {
        let parameters = node
            .items
            .iter()
            .map(|item| {
                let pattern = self.pattern(&item.pattern)?;
                match &item.initializer {
                    Some(value) => Ok(Pattern::Default(
                        Box::new(pattern),
                        Box::new(self.expression(value)?),
                    )),
                    None => Ok(pattern),
                }
            })
            .collect::<Result<_, Diagnostic>>()?;
        let rest = node
            .rest
            .as_ref()
            .map(|value| self.pattern(&value.rest.argument).map(Box::new))
            .transpose()?;
        Ok((parameters, rest))
    }

    fn pattern(&self, node: &ast::BindingPattern<'_>) -> Result<Pattern, Diagnostic> {
        Ok(match node {
            ast::BindingPattern::BindingIdentifier(value) => {
                Pattern::Identifier(value.name.to_string())
            }
            ast::BindingPattern::AssignmentPattern(value) => Pattern::Default(
                Box::new(self.pattern(&value.left)?),
                Box::new(self.expression(&value.right)?),
            ),
            ast::BindingPattern::ArrayPattern(value) => Pattern::Array(
                value
                    .elements
                    .iter()
                    .map(|item| item.as_ref().map(|item| self.pattern(item)).transpose())
                    .collect::<Result<_, _>>()?,
                value
                    .rest
                    .as_ref()
                    .map(|rest| self.pattern(&rest.argument).map(Box::new))
                    .transpose()?,
            ),
            ast::BindingPattern::ObjectPattern(value) => Pattern::Object(
                value
                    .properties
                    .iter()
                    .map(|item| {
                        Ok((
                            self.key(&item.key, item.computed)?,
                            self.pattern(&item.value)?,
                        ))
                    })
                    .collect::<Result<_, Diagnostic>>()?,
                value
                    .rest
                    .as_ref()
                    .map(|rest| self.pattern(&rest.argument).map(Box::new))
                    .transpose()?,
            ),
        })
    }

    fn simple_target(&self, node: &ast::SimpleAssignmentTarget<'_>) -> Result<Pattern, Diagnostic> {
        match node {
            ast::SimpleAssignmentTarget::AssignmentTargetIdentifier(value) => {
                Ok(Pattern::Identifier(value.name.to_string()))
            }
            ast::SimpleAssignmentTarget::StaticMemberExpression(value) => Ok(Pattern::Member(
                Box::new(self.expression(&value.object)?),
                Box::new(self.string_key(value.property.name.as_str(), value.property.span)),
            )),
            ast::SimpleAssignmentTarget::ComputedMemberExpression(value) => Ok(Pattern::Member(
                Box::new(self.expression(&value.object)?),
                Box::new(self.expression(&value.expression)?),
            )),
            ast::SimpleAssignmentTarget::TSAsExpression(value) => {
                self.expression_target(&value.expression)
            }
            ast::SimpleAssignmentTarget::TSSatisfiesExpression(value) => {
                self.expression_target(&value.expression)
            }
            ast::SimpleAssignmentTarget::TSNonNullExpression(value) => {
                self.expression_target(&value.expression)
            }
            ast::SimpleAssignmentTarget::TSTypeAssertion(value) => {
                self.expression_target(&value.expression)
            }
            ast::SimpleAssignmentTarget::PrivateFieldExpression(value) => {
                Err(self.unsupported("PrivateFieldExpression", value.span))
            }
        }
    }

    fn expression_target(&self, node: &ast::Expression<'_>) -> Result<Pattern, Diagnostic> {
        let expression = self.expression(node)?;
        match expression.kind {
            ExpressionKind::Identifier(name) => Ok(Pattern::Identifier(name)),
            ExpressionKind::Member(object, key, _) => Ok(Pattern::Member(object, key)),
            _ => Err(self.unsupported("AssignmentTarget", node.span())),
        }
    }

    fn target(&self, node: &ast::AssignmentTarget<'_>) -> Result<Pattern, Diagnostic> {
        match node {
            ast::AssignmentTarget::ArrayAssignmentTarget(value) => Ok(Pattern::Array(
                value
                    .elements
                    .iter()
                    .map(|item| {
                        item.as_ref()
                            .map(|item| self.target_default(item))
                            .transpose()
                    })
                    .collect::<Result<_, _>>()?,
                value
                    .rest
                    .as_ref()
                    .map(|rest| self.target(&rest.target).map(Box::new))
                    .transpose()?,
            )),
            ast::AssignmentTarget::ObjectAssignmentTarget(value) => Ok(Pattern::Object(
                value
                    .properties
                    .iter()
                    .map(|item| match item {
                        ast::AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(
                            value,
                        ) => {
                            let pattern = Pattern::Identifier(value.binding.name.to_string());
                            Ok((
                                self.string_key(value.binding.name.as_str(), value.binding.span),
                                match &value.init {
                                    Some(init) => Pattern::Default(
                                        Box::new(pattern),
                                        Box::new(self.expression(init)?),
                                    ),
                                    None => pattern,
                                },
                            ))
                        }
                        ast::AssignmentTargetProperty::AssignmentTargetPropertyProperty(value) => {
                            Ok((
                                self.key(&value.name, value.computed)?,
                                self.target_default(&value.binding)?,
                            ))
                        }
                    })
                    .collect::<Result<_, Diagnostic>>()?,
                value
                    .rest
                    .as_ref()
                    .map(|rest| self.target(&rest.target).map(Box::new))
                    .transpose()?,
            )),
            value => self.simple_target(value.to_simple_assignment_target()),
        }
    }

    fn target_default(
        &self,
        node: &ast::AssignmentTargetMaybeDefault<'_>,
    ) -> Result<Pattern, Diagnostic> {
        match node {
            ast::AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(value) => {
                Ok(Pattern::Default(
                    Box::new(self.target(&value.binding)?),
                    Box::new(self.expression(&value.init)?),
                ))
            }
            value => self.target(value.to_assignment_target()),
        }
    }
}

pub(crate) fn blocked(key: &LosslessString) -> bool {
    key.as_str()
        .is_some_and(|key| ["__proto__", "constructor", "prototype"].contains(&key))
}

fn decode_literal(raw: &[u16], template: bool) -> LosslessString {
    let mut units = Vec::new();
    let mut index = 0;
    while index < raw.len() {
        let unit = raw[index];
        index += 1;
        if unit != u16::from(b'\\') {
            if template && unit == 13 {
                if raw.get(index) == Some(&10) {
                    index += 1;
                }
                units.push(10);
                continue;
            }
            units.push(unit);
            continue;
        }
        let escaped = raw[index];
        index += 1;
        match escaped {
            10 | 0x2028 | 0x2029 => {}
            13 => {
                if raw.get(index) == Some(&10) {
                    index += 1;
                }
            }
            98 => units.push(8),
            102 => units.push(12),
            110 => units.push(10),
            114 => units.push(13),
            116 => units.push(9),
            118 => units.push(11),
            120 | 117 => {
                let braces = escaped == 117 && raw.get(index) == Some(&123);
                let length = if braces {
                    index += 1;
                    raw[index..]
                        .iter()
                        .position(|unit| *unit == 125)
                        .expect("A parsed Unicode escape has a closing brace")
                } else if escaped == 120 {
                    2
                } else {
                    4
                };
                let mut value = 0u32;
                for unit in &raw[index..index + length] {
                    value = value * 16
                        + char::from_u32(*unit as u32)
                            .and_then(|value| value.to_digit(16))
                            .expect("A parsed escape contains hexadecimal digits");
                }
                index += length + usize::from(braces);
                if value <= u16::MAX as u32 {
                    units.push(value as u16);
                } else {
                    units.extend(
                        char::from_u32(value)
                            .expect("A parsed Unicode escape is in range")
                            .encode_utf16(&mut [0; 2])
                            .iter()
                            .copied(),
                    );
                }
            }
            48..=55 => {
                let mut value = escaped - 48;
                for _ in 0..if escaped <= 51 { 2 } else { 1 } {
                    let Some(next) = raw
                        .get(index)
                        .copied()
                        .filter(|unit| (48..=55).contains(unit))
                    else {
                        break;
                    };
                    value = value * 8 + next - 48;
                    index += 1;
                }
                units.push(value);
            }
            _ => units.push(escaped),
        }
    }
    LosslessString::from_utf16(units)
}
