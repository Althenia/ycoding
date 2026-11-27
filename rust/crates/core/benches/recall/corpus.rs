use serde_json::Value;
use std::collections::BTreeMap;

pub struct Concept {
    pub id: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub identifiers: Vec<String>,
    pub body: String,
}

pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub keywords: String,
    pub auto: bool,
}

pub struct Query {
    pub id: String,
    pub skill: bool,
    pub category: String,
    pub text: String,
    pub holdout: bool,
    pub relevant: BTreeMap<String, u32>,
}

pub struct Corpus {
    pub concepts: Vec<Concept>,
    pub skills: Vec<Skill>,
    pub queries: Vec<Query>,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

fn list(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

pub fn load() -> Corpus {
    let root: Value = serde_json::from_str(include_str!("../cue-recall-labelled.json")).unwrap();
    Corpus {
        concepts: root["concepts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Concept {
                id: text(c, "id"),
                title: text(c, "title"),
                description: text(c, "description"),
                tags: list(c, "tags"),
                identifiers: list(c, "identifiers"),
                body: text(c, "body"),
            })
            .collect(),
        skills: root["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| Skill {
                id: text(s, "id"),
                name: text(s, "name"),
                description: text(s, "description"),
                keywords: text(s, "keywords"),
                auto: s["activation"] == "auto",
            })
            .collect(),
        queries: root["queries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| Query {
                id: text(q, "id"),
                skill: q["kind"] == "skill",
                category: text(q, "category"),
                text: text(q, "text"),
                holdout: q["split"] == "holdout",
                relevant: q["relevant"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(id, grade)| (id.clone(), grade.as_u64().unwrap() as u32))
                    .collect(),
            })
            .collect(),
    }
}
