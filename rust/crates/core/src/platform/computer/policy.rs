use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Forbidden,
    Elevated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub bundle_id: String,
    pub decision: Decision,
    pub reason: &'static str,
}

const FORBIDDEN: [(&str, &str); 6] = [
    (
        "com.apple.systempreferences",
        "System Settings can grant permissions and change account security",
    ),
    (
        "com.apple.keychainaccess",
        "Keychain Access stores credentials",
    ),
    ("com.1password.1password", "1Password stores credentials"),
    ("com.bitwarden.desktop", "Bitwarden stores credentials"),
    (
        "com.dashlane.dashlanephonefinal",
        "Dashlane stores credentials",
    ),
    (
        "app.ycoding.computer-use",
        "the computer-use approval UI cannot approve itself",
    ),
];

const ELEVATED: [&str; 26] = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.github.wez.wezterm",
    "dev.zed.Zed",
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",
    "com.jetbrains.intellij",
    "com.jetbrains.goland",
    "com.jetbrains.WebStorm",
    "com.jetbrains.PyCharm",
    "com.jetbrains.rubymine",
    "com.jetbrains.AppCode",
    "com.apple.dt.Xcode",
    "com.barebones.bbedit",
    "de.fme.GitHubDesktop",
    "com.github.GitHubDesktop",
    "com.torusknot.SourceTreeNotMAS",
    "org.mozilla.firefoxdeveloperedition",
    "com.google.Chrome.dev",
    "com.inspect.terminal",
    "com.apple.Console",
    "com.apple.ActivityMonitor",
];

pub fn evaluate(bundle_id: &str, allowed: &[String]) -> Evaluation {
    if bundle_id.eq_ignore_ascii_case("app.ycoding.interaction") {
        return Evaluation {
            bundle_id: bundle_id.into(),
            decision: Decision::Forbidden,
            reason: "native Interaction approval and enrollment are private",
        };
    }
    let allowed: HashSet<String> = allowed.iter().map(|value| value.to_lowercase()).collect();
    if !allowed.contains(&bundle_id.to_lowercase())
        && let Some((_, reason)) = FORBIDDEN
            .iter()
            .find(|(id, _)| id.eq_ignore_ascii_case(bundle_id))
    {
        return Evaluation {
            bundle_id: bundle_id.into(),
            decision: Decision::Forbidden,
            reason,
        };
    }
    if ELEVATED.iter().any(|id| id.eq_ignore_ascii_case(bundle_id)) {
        return Evaluation {
            bundle_id: bundle_id.into(),
            decision: Decision::Elevated,
            reason: "terminals execute arbitrary commands",
        };
    }
    Evaluation {
        bundle_id: bundle_id.into(),
        decision: Decision::Allowed,
        reason: "application is allowed",
    }
}

pub fn override_from_env(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn evaluate_from_env(bundle_id: &str) -> Evaluation {
    evaluate(
        bundle_id,
        &override_from_env(std::env::var("YCODING_COMPUTER_ALLOW_APPS").ok().as_deref()),
    )
}
