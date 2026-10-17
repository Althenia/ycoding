use crate::session::prompt_cache::canonical_json;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder,
    schema::NonNegativeInt,
    session_orchestration::{State, Task, TeamView},
    stringify_json,
};
use ycoding_store::{Error, session};

pub const TEAM_VIEW_BYTES: usize = 32 * 1024;
const PREFIX: &str = "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n";

#[derive(Clone, Debug, PartialEq)]
pub struct Rendered {
    pub view: JsonValue,
    pub text: String,
}

pub fn is_terminal(state: &State) -> bool {
    matches!(
        state,
        State::Cancelled | State::Completed | State::Failed | State::Lost
    )
}

pub fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn task_from_row(row: &session::Task) -> Result<Task, Error> {
    let progress = row
        .progress
        .as_ref()
        .zip(row.progress_time)
        .map(|(text, time)| {
            ObjectEncoder::new()
                .field("text", text)
                .field("time", &(time as f64))
                .finish()
        });
    let question = row
        .question_id
        .as_ref()
        .zip(row.question.as_ref())
        .zip(row.question_time)
        .map(|((id, text), time)| {
            ObjectEncoder::new()
                .field("id", id)
                .field("text", text)
                .optional(
                    "data",
                    &row.question_data.as_ref().map(|data| data.value().clone()),
                )
                .field("time", &(time as f64))
                .finish()
        });
    Task::decode(
        &ObjectEncoder::new()
            .field("sessionID", &row.session_id)
            .field("parentID", &row.parent_id)
            .field("description", &row.description)
            .field("agent", &row.agent)
            .field("model", row.model.value())
            .field("background", &(row.background != 0))
            .field("state", &row.state)
            .optional("progress", &progress)
            .optional("question", &question)
            .field("revision", &(row.revision as f64))
            .field(
                "time",
                &ObjectEncoder::new()
                    .field("created", &(row.time_created as f64))
                    .field("updated", &(row.time_updated as f64))
                    .finish(),
            )
            .finish(),
    )
    .map_err(|error| Error::Record(Box::new(error)))
}

pub fn render_team_view(tasks: &[Task], max_bytes: usize) -> Result<Rendered, Error> {
    let mut sorted = tasks.to_vec();
    sorted.sort_by(|left, right| {
        is_terminal(&left.state)
            .cmp(&is_terminal(&right.state))
            .then_with(|| right.time.updated.get().cmp(&left.time.updated.get()))
            .then_with(|| {
                left.session_id
                    .as_lossless()
                    .to_utf8()
                    .ok()
                    .cmp(&right.session_id.as_lossless().to_utf8().ok())
            })
    });
    let fit = |children: Vec<Task>, omitted: usize| -> Result<(JsonValue, String), Error> {
        let view = TeamView {
            children,
            omitted: NonNegativeInt::new(omitted as i64)
                .map_err(|error| Error::Record(Box::new(error)))?,
        }
        .encode();
        let text = format!("{PREFIX}{}", stringify_json(&view));
        Ok((view, text))
    };
    let mut children = Vec::new();
    for task in &sorted {
        let mut candidate = children.clone();
        candidate.push(task.clone());
        let omitted = sorted.len() - candidate.len();
        if fit(candidate, omitted)?.1.len() > max_bytes {
            break;
        }
        children.push(task.clone());
    }
    let omitted = sorted.len() - children.len();
    let (view, text) = fit(children, omitted)?;
    Ok(Rendered { view, text })
}

pub fn render_team_observation(tasks: &[Task], max_bytes: usize) -> Rendered {
    let mut sorted = tasks.iter().map(observed).collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .has_question
            .cmp(&left.has_question)
            .then_with(|| is_terminal(&left.state).cmp(&is_terminal(&right.state)))
            .then_with(|| left.id.cmp(&right.id))
    });
    let render = |children: &[&Observed], omitted: usize| {
        let view = ObjectEncoder::new()
            .field(
                "children",
                &children
                    .iter()
                    .map(|task| task.json.clone())
                    .collect::<Vec<_>>(),
            )
            .field("omitted", &(omitted as f64))
            .finish();
        let text = format!("{PREFIX}{}", canonical_json(&view));
        (view, text)
    };
    let mut children = Vec::<&Observed>::new();
    for task in &sorted {
        let mut candidate = children.clone();
        candidate.push(task);
        if render(&candidate, sorted.len() - candidate.len()).1.len() > max_bytes {
            break;
        }
        children.push(task);
    }
    let (view, text) = render(&children, sorted.len() - children.len());
    Rendered { view, text }
}

struct Observed {
    id: String,
    state: State,
    has_question: bool,
    json: JsonValue,
}

fn observed(task: &Task) -> Observed {
    let encoded = task.encode();
    let JsonValue::Object(fields) = &encoded else {
        return Observed {
            id: String::new(),
            state: task.state.clone(),
            has_question: false,
            json: encoded,
        };
    };
    let mut json = ycoding_schema::JsonObject::new();
    for key in [
        "sessionID",
        "parentID",
        "description",
        "agent",
        "model",
        "background",
        "state",
    ] {
        if let Some(value) = fields.get(&key.into()) {
            json.insert(key.into(), value.clone());
        }
    }
    if let Some(progress) = &task.progress {
        json.insert(
            "progress".into(),
            ObjectEncoder::new().field("text", &progress.text).finish(),
        );
    }
    if let Some(question) = &task.question {
        json.insert(
            "question".into(),
            ObjectEncoder::new()
                .field("id", &question.id)
                .field("text", &question.text)
                .optional("data", &question.data)
                .optional("deferred", &question.deferred.filter(|deferred| *deferred))
                .finish(),
        );
    }
    Observed {
        id: task.session_id.as_lossless().to_utf8().unwrap_or_default(),
        state: task.state.clone(),
        has_question: task.question.is_some(),
        json: JsonValue::Object(json),
    }
}
