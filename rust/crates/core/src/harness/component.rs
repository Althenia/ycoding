#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Component {
    SystemPrompt,
    Guardrails,
    Memory,
    ToolGuidance,
    Subagents,
    Skills,
    Scripts,
    Plugins,
}

impl Component {
    pub const ALL: [Self; 8] = [
        Self::SystemPrompt,
        Self::Guardrails,
        Self::Memory,
        Self::ToolGuidance,
        Self::Subagents,
        Self::Skills,
        Self::Scripts,
        Self::Plugins,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SystemPrompt => "system-prompt",
            Self::Guardrails => "guardrails",
            Self::Memory => "memory",
            Self::ToolGuidance => "tool-guidance",
            Self::Subagents => "subagents",
            Self::Skills => "skills",
            Self::Scripts => "scripts",
            Self::Plugins => "plugins",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Adaptive,
    Parallel,
    Sequential,
    Disabled,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::Parallel => "parallel",
            Self::Sequential => "sequential",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Origin {
    General,
    Domain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Stage {
    Baseline,
    Propose,
    Probe,
    Compose,
    Adopt,
}
