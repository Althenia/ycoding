include!("tool_fixture.rs");
use std::{fs, sync::Arc};
use ycoding_core::tools::{
    builtin::{read::Read, skill},
    context::{
        Context,
        consumers::{ActiveSkill, ConsumerFuture, ReadInstructions},
    },
};
use ycoding_schema::{schema::AbsolutePath, skill::Info};

#[derive(Default)]
struct Instructions(std::sync::Mutex<Vec<std::path::PathBuf>>);
impl ReadInstructions for Instructions {
    fn load(&self, _: Context, paths: Vec<std::path::PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().extend(paths);
            Ok(())
        })
    }
}

#[tokio::test]
async fn local_skill_rendering_and_active_resource_reads_are_fenced_to_the_skill_directory() {
    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("effect")).unwrap();
    fs::write(fixture.root.join("effect/SKILL.md"), "skill").unwrap();
    fs::write(fixture.root.join("effect/reference.md"), "reference text").unwrap();
    fs::write(fixture.root.join("outside.md"), "outside").unwrap();
    let info = Info {
        id: "effect".into(),
        name: "Effect & Rust".into(),
        description: None,
        slash: None,
        autoinvoke: None,
        conflicts: None,
        location: AbsolutePath::new(
            fixture
                .root
                .join("effect/SKILL.md")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
        content: "\nUse <effect>.\n".into(),
    };
    let output = skill::load_local(&info, &fixture.policy, fixture.context())
        .await
        .unwrap();
    let text = output.output.as_str().unwrap();
    assert!(text.starts_with("<skill_content name=\"Effect &amp; Rust\">\n# Skill: Effect &amp; Rust\n\nUse <effect>.\n\n"));
    assert!(text.contains(&format!(
        "<file>{}</file>",
        fixture.root.join("effect/reference.md").display()
    )));
    assert!(!text.contains("<file>SKILL.md</file>"));
    let instructions = Arc::new(Instructions::default());
    let reader = Read {
        paths: fixture.paths(),
        policy: fixture.policy.clone(),
        instructions: instructions.clone(),
        collator: Arc::new(|left, right| left.cmp(right)),
    };
    let active = ActiveSkill {
        id: "effect".into(),
        name: "Held name".into(),
        entry: None,
    };
    let resource =
        skill::read_local_resource(&info, &active, "reference.md", &reader, fixture.context())
            .await
            .unwrap();
    assert_eq!(resource.name.as_str(), Some("Held name"));
    assert_eq!(resource.already_active, Some(true));
    assert!(
        resource
            .output
            .as_str()
            .unwrap()
            .ends_with(">\nreference text\n</skill_resource>")
    );
    assert!(instructions.0.lock().unwrap().is_empty());
    assert!(
        skill::read_local_resource(&info, &active, "../outside.md", &reader, fixture.context())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fixture.root.join("outside.md"),
            fixture.root.join("effect/link.md"),
        )
        .unwrap();
        assert!(
            skill::read_local_resource(&info, &active, "link.md", &reader, fixture.context())
                .await
                .is_err()
        );
    }
    fixture.cleanup();
}
