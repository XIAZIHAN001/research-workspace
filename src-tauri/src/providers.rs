//! The model providers this build offers.
//!
//! One table, read by the settings page and by the credential store, so the identifier a
//! preference file holds, the identifier a credential target is built from and the identifier the
//! sidecar receives are all the same string.
//!
//! Every preset is an OpenAI-compatible chat-completions endpoint: `POST {base}/chat/completions`
//! with `Authorization: Bearer …`. DeepSeek is the one dialect that also takes `thinking` and
//! `reasoning_effort`; the others are sent only the fields they document. A provider that does not
//! speak this protocol at all is reachable through the `custom` entry only if it offers a
//! compatible endpoint.
//!
//! The base URLs below are the ones the vendors publish today. They are presets, not walls: the
//! settings page lets the reader replace one with a mirror or a gateway, which is why the base URL
//! is stored with the settings instead of being derived from the provider id at call time.

use serde::Serialize;

/// The provider a new installation starts on. Matches `DEFAULT_MODEL`/`DEFAULT_BASE_URL` below.
pub const DEFAULT_PROVIDER: &str = "deepseek";
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
pub const DEFAULT_MODEL: &str = "deepseek-flash";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
    /// Suggestions shown next to the model field. The list is not a whitelist: any syntactically
    /// valid name is accepted, and `list_ai_models` can replace these with what the account
    /// actually has.
    pub models: &'static [&'static str],
    /// Whether the endpoint understands DeepSeek's `thinking` / `reasoning_effort` pair.
    pub supports_thinking: bool,
}

pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "deepseek",
        label: "DeepSeek",
        base_url: DEFAULT_BASE_URL,
        default_model: DEFAULT_MODEL,
        models: &["deepseek-flash", "deepseek-v4-pro"],
        supports_thinking: true,
    },
    ProviderPreset {
        id: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com/v1",
        default_model: "gpt-4o-mini",
        models: &["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
        supports_thinking: false,
    },
    ProviderPreset {
        id: "moonshot",
        label: "Moonshot（Kimi）",
        base_url: "https://api.moonshot.cn/v1",
        default_model: "moonshot-v1-8k",
        models: &["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-0905-preview"],
        supports_thinking: false,
    },
    ProviderPreset {
        id: "zhipu",
        label: "智谱 GLM",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        default_model: "glm-4-flash",
        models: &["glm-4-flash", "glm-4-air", "glm-4-plus"],
        supports_thinking: false,
    },
    ProviderPreset {
        id: "dashscope",
        label: "通义千问",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen-plus",
        models: &["qwen-plus", "qwen-turbo", "qwen-max"],
        supports_thinking: false,
    },
    ProviderPreset {
        id: "custom",
        label: "自定义（OpenAI 兼容）",
        // Empty on purpose: a custom endpoint has no default, and the settings page asks for one
        // instead of guessing.
        base_url: "",
        default_model: "",
        models: &[],
        supports_thinking: false,
    },
];

pub fn all() -> &'static [ProviderPreset] {
    PRESETS
}

pub fn find(id: &str) -> Option<&'static ProviderPreset> {
    PRESETS.iter().find(|preset| preset.id == id)
}

/// A model name may contain `/`, `:` and `@`: gateways and aggregators use names such as
/// `openai/gpt-4o`, `accounts/…/models/…` or `meta-llama/llama-3.1-8b-instruct:free`.
///
/// It still has to survive being put in a JSON body and in a URL path, so only unreserved
/// characters plus those three separators are accepted.
pub fn is_valid_model_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:/@-".contains(character))
}

/// Trims and removes trailing slashes, so `{base}/chat/completions` always joins correctly.
pub fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// True only for authorities that cannot leave the machine: `localhost`, `127.0.0.0/8` and
/// `[::1]`. Prefix matching is not enough: `127.example.com` starts with `127.` and resolves
/// wherever its owner says.
fn is_loopback_authority(authority: &str) -> bool {
    let host = if authority.starts_with('[') {
        match authority.find(']') {
            Some(end) => &authority[..=end],
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.eq_ignore_ascii_case("localhost") || host == "[::1]" {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// Accepts https anywhere, and plain http only on loopback.
///
/// The loopback exception is for models run on the same machine (Ollama, LM Studio, a local
/// gateway). Anything else over http would put the key on the wire in clear text.
pub fn validate_base_url(value: &str) -> Result<(), String> {
    let value = normalize_base_url(value);
    if value.is_empty() {
        return Err("请填写 API 地址。".to_string());
    }
    if value.chars().any(|character| character.is_whitespace() || character.is_control()) {
        return Err("API 地址不能包含空格或控制字符。".to_string());
    }

    let rest = if let Some(rest) = value.strip_prefix("https://") {
        rest
    } else if let Some(rest) = value.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or("");
        if !is_loopback_authority(authority) {
            return Err("只有本机地址（127.0.0.1 / localhost）可以使用 http；其他地址必须是 https。".to_string());
        }
        rest
    } else {
        return Err("API 地址必须以 https:// 开头（本机服务可以用 http://）。".to_string());
    };

    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains('@') || host.starts_with(':') {
        return Err("API 地址缺少有效的主机名。".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_name_a_real_preset() {
        let preset = find(DEFAULT_PROVIDER).expect("the default provider is in the table");
        assert_eq!(preset.base_url, DEFAULT_BASE_URL);
        assert_eq!(preset.default_model, DEFAULT_MODEL);
        assert!(preset.supports_thinking);
    }

    #[test]
    fn provider_ids_are_unique() {
        let mut ids: Vec<&str> = all().iter().map(|preset| preset.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), all().len());
    }

    #[test]
    fn only_the_documented_efforts_exist() {
        assert!(find("deepseek").is_some());
        assert!(find("mock").is_none());
        assert!(find("DeepSeek").is_none());
    }

    #[test]
    fn model_names_allow_gateway_separators() {
        assert!(is_valid_model_name("deepseek-flash"));
        assert!(is_valid_model_name("openai/gpt-4o"));
        assert!(is_valid_model_name("meta-llama/llama-3.1-8b-instruct:free"));
        assert!(is_valid_model_name("accounts/acme/models/qwen3-32b"));
        assert!(!is_valid_model_name(""));
        assert!(!is_valid_model_name("model name"));
        assert!(!is_valid_model_name("model\"}\n{\"x\":1"));
        assert!(!is_valid_model_name(&"a".repeat(129)));
    }

    #[test]
    fn base_urls_must_be_https_or_loopback() {
        assert!(validate_base_url("https://api.deepseek.com").is_ok());
        assert!(validate_base_url("https://example.test/v1/").is_ok());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("http://localhost:1234/v1").is_ok());
        assert!(validate_base_url("http://[::1]:11434/v1").is_ok());
        assert!(validate_base_url("http://api.example.com/v1").is_err());
        // A host name is not an address just because it starts with `127.`.
        assert!(validate_base_url("http://127.example.com/v1").is_err());
        assert!(validate_base_url("http://localhost.example.com/v1").is_err());
        assert!(validate_base_url("ftp://example.com").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn trailing_slashes_are_removed() {
        assert_eq!(normalize_base_url(" https://a.test/v1// "), "https://a.test/v1");
    }
}
