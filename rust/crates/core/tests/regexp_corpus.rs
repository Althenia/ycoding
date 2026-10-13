use ycoding_core::regexp::{Budget, Match, RegExp, StringMatch, escape, replace_matches};

#[test]
fn corpus_0_codemode_287() {
    {
        let regex = RegExp::new(&[97, 98], "g").unwrap();
        assert_eq!(regex.source(), &[97, 98]);
        assert_eq!(regex.flags(), "g");
    }
}

#[test]
fn corpus_1_callbacks_84() {
    {
        let regex = RegExp::new(&[92, 100], "").unwrap();
        assert_eq!(regex.source(), &[92, 100]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[97, 49, 98, 50], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(vec![Some([49].to_vec())], 1, None)]
        );
        let replacements = vec![[49].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[97, 49, 98, 50],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [97, 49, 98, 50].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_2_callbacks_118() {
    {
        let regex = RegExp::new(
            &[
                94, 92, 100, 123, 52, 125, 45, 92, 100, 123, 50, 125, 45, 92, 100, 123, 50, 125,
                84, 46, 42, 90, 36,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                94, 92, 100, 123, 52, 125, 45, 92, 100, 123, 50, 125, 45, 92, 100, 123, 50, 125,
                84, 46, 42, 90, 36
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(
            &[
                94, 92, 100, 123, 52, 125, 45, 92, 100, 123, 50, 125, 45, 92, 100, 123, 50, 125,
                84, 46, 42, 90, 36,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(
            regex
                .test(
                    &[
                        50, 48, 50, 52, 45, 48, 49, 45, 48, 49, 84, 48, 48, 58, 48, 48, 58, 48, 48,
                        46, 48, 48, 48, 90
                    ],
                    &mut budget
                )
                .unwrap()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98], "").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[98], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.replace(&[97, 98, 99], &[120], &mut budget).unwrap(),
            [97, 120, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_3_callbacks_263() {
    {
        let regex = RegExp::new(&[98], "").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_4_callbacks_269() {
    {
        let regex = RegExp::new(&[98], "").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[98], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[97, 98, 99], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(vec![Some([98].to_vec())], 1, None)]
        );
        let replacements = vec![[98].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[97, 98, 99],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [97, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 100, 92, 46, 92, 100], "").unwrap();
        assert_eq!(regex.source(), &[92, 100, 92, 46, 92, 100]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 92, 46, 92, 100], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[51, 46, 55], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(vec![Some([51, 46, 55].to_vec())], 0, None)]
        );
        let replacements = vec![[51, 46, 55].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[51, 46, 55],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [51, 46, 55].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_5_parity_365() {
    assert!(RegExp::new(&[40], "").is_err());
    assert!(RegExp::new(&[40], "").is_err());
}

#[test]
fn corpus_6_parity_811() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_7_parity_826() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(regex.search(&[97, 98, 99], &mut budget).unwrap(), Some(0));
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97, 98, 99], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([0u16; 0].to_vec())],
                index: 0,
                groups: None,
                indices: None,
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_8_parity_871() {
    assert_eq!(
        escape(&[97, 46, 98]),
        [92, 120, 54, 49, 92, 46, 98].to_vec()
    );
}

#[test]
fn corpus_9_stdlib_205() {
    {
        let regex = RegExp::new(&[97, 98, 43, 99], "").unwrap();
        assert_eq!(regex.source(), &[97, 98, 43, 99]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97, 98, 43, 99], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(regex.test(&[120, 97, 98, 98, 98, 99], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 98, 43, 99], "").unwrap();
        assert_eq!(regex.source(), &[97, 98, 43, 99]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97, 98, 43, 99], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(!regex.test(&[110, 111, 112, 101], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_10_stdlib_210() {
    {
        let regex = RegExp::new(&[97, 40, 98, 43, 41], "").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 43, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 43, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .exec(&[120, 120, 97, 98, 98, 99], &mut budget)
                .unwrap(),
            Some(Match {
                captures: vec![Some([97, 98, 98].to_vec()), Some([98, 98].to_vec())],
                index: 2,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(regex.exec(&[122, 122, 122], &mut budget).unwrap(), None);
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_11_stdlib_221() {
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 119, 111, 114, 100, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                110, 117, 109, 62, 92, 100, 43, 41,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 119, 111, 114, 100, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                110, 117, 109, 62, 92, 100, 43, 41
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 119, 111, 114, 100, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                110, 117, 109, 62, 92, 100, 43, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .exec(&[105, 100, 32, 97, 98, 45, 52, 50], &mut budget)
                .unwrap(),
            Some(Match {
                captures: vec![
                    Some([97, 98, 45, 52, 50].to_vec()),
                    Some([97, 98].to_vec()),
                    Some([52, 50].to_vec())
                ],
                index: 3,
                groups: Some(vec![
                    ([119, 111, 114, 100].to_vec(), Some([97, 98].to_vec())),
                    ([110, 117, 109].to_vec(), Some([52, 50].to_vec()))
                ]),
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_12_stdlib_227() {
    {
        let regex = RegExp::new(&[92, 100, 43], "g").unwrap();
        assert_eq!(regex.source(), &[92, 100, 43]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 43], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97, 49, 98, 50, 50, 99], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([49].to_vec())],
                index: 1,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 2);
    }
    {
        let mut regex = RegExp::new(&[92, 100, 43], "g").unwrap();
        regex.last_index = 2;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97, 49, 98, 50, 50, 99], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([50, 50].to_vec())],
                index: 3,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 5);
    }
}

#[test]
fn corpus_13_stdlib_238() {
    {
        let regex = RegExp::new(&[40, 63, 58, 97, 98, 124, 99, 100, 41, 92, 100, 63], "g").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 58, 97, 98, 124, 99, 100, 41, 92, 100, 63]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex =
            RegExp::new(&[40, 63, 58, 97, 98, 124, 99, 100, 41, 92, 100, 63], "g").unwrap();
        regex.last_index = 12;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .exec(
                    &[
                        97, 97, 99, 100, 50, 50, 51, 51, 97, 98, 49, 50, 110, 109, 52, 52, 52, 97,
                        98, 52, 50
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(Match {
                captures: vec![Some([97, 98, 52].to_vec())],
                index: 17,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 20);
    }
}

#[test]
fn corpus_14_stdlib_251() {
    {
        let regex = RegExp::new(&[97], "g").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[98, 97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 1,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 2);
    }
    {
        let mut regex = RegExp::new(&[97], "g").unwrap();
        regex.last_index = 10;
        let mut budget = Budget::unlimited();
        assert_eq!(regex.exec(&[97], &mut budget).unwrap(), None);
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_15_stdlib_265() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[98, 97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 1,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(regex.test(&[98, 97], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_16_stdlib_283() {
    {
        let regex = RegExp::new(&[92, 100], "").unwrap();
        assert_eq!(regex.source(), &[92, 100]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97, 98, 99], &mut budget).unwrap(),
            None
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_17_stdlib_287() {
    {
        let regex = RegExp::new(&[40, 92, 100, 43, 41], "g").unwrap();
        assert_eq!(regex.source(), &[40, 92, 100, 43, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[40, 92, 100, 43, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97, 49, 98, 50, 50], &mut budget).unwrap(),
            vec![
                Match {
                    captures: vec![Some([49].to_vec()), Some([49].to_vec())],
                    index: 1,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([50, 50].to_vec()), Some([50, 50].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_18_stdlib_291() {
    {
        let regex = RegExp::new(&[40, 92, 100, 41, 40, 92, 100, 41, 63], "g").unwrap();
        assert_eq!(regex.source(), &[40, 92, 100, 41, 40, 92, 100, 41, 63]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[40, 92, 100, 41, 40, 92, 100, 41, 63], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[97, 49, 98, 50, 50], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    vec![Some([49].to_vec()), Some([49].to_vec()), None],
                    1,
                    None
                ),
                (
                    vec![
                        Some([50, 50].to_vec()),
                        Some([50].to_vec()),
                        Some([50].to_vec())
                    ],
                    3,
                    None
                )
            ]
        );
        let replacements = vec![[49].to_vec(), [50, 50].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[97, 49, 98, 50, 50],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [97, 49, 98, 50, 50].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 108, 101, 102, 116, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                114, 105, 103, 104, 116, 62, 91, 97, 45, 122, 93, 43, 41,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 108, 101, 102, 116, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                114, 105, 103, 104, 116, 62, 91, 97, 45, 122, 93, 43, 41
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 108, 101, 102, 116, 62, 91, 97, 45, 122, 93, 43, 41, 45, 40, 63, 60,
                114, 105, 103, 104, 116, 62, 91, 97, 45, 122, 93, 43, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[114, 101, 100, 45, 98, 108, 117, 101], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(
                vec![
                    Some([114, 101, 100, 45, 98, 108, 117, 101].to_vec()),
                    Some([114, 101, 100].to_vec()),
                    Some([98, 108, 117, 101].to_vec())
                ],
                0,
                Some(vec![
                    (
                        [108, 101, 102, 116].to_vec(),
                        Some([114, 101, 100].to_vec())
                    ),
                    (
                        [114, 105, 103, 104, 116].to_vec(),
                        Some([98, 108, 117, 101].to_vec())
                    )
                ])
            )]
        );
        let replacements = vec![[114, 101, 100, 45, 98, 108, 117, 101].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[114, 101, 100, 45, 98, 108, 117, 101],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [114, 101, 100, 45, 98, 108, 117, 101].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_19_stdlib_318() {
    {
        let regex = RegExp::new(&[40, 63, 58, 41], "gu").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "gu").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[55357, 56832], true, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                (vec![Some([0u16; 0].to_vec())], 0, None),
                (vec![Some([0u16; 0].to_vec())], 2, None)
            ]
        );
        let replacements = vec![[0u16; 0].to_vec(), [0u16; 0].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[55357, 56832],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [55357, 56832].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 100], "g").unwrap();
        assert_eq!(regex.source(), &[92, 100]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 100], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[49, 50, 51], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                (vec![Some([49].to_vec())], 0, None),
                (vec![Some([50].to_vec())], 1, None),
                (vec![Some([51].to_vec())], 2, None)
            ]
        );
        let replacements = vec![[49].to_vec(), [50].to_vec(), [51].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[49, 50, 51],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [49, 50, 51].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_20_stdlib_327() {
    {
        let regex = RegExp::new(&[92, 100, 43], "g").unwrap();
        assert_eq!(regex.source(), &[92, 100, 43]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 43], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[97, 49, 98, 50, 50], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                (vec![Some([49].to_vec())], 1, None),
                (vec![Some([50, 50].to_vec())], 3, None)
            ]
        );
        let replacements = vec![[49].to_vec(), [50, 50].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[97, 49, 98, 50, 50],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [97, 49, 98, 50, 50].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 100], "").unwrap();
        assert_eq!(regex.source(), &[92, 100]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        let matches = regex
            .replacement_matches(&[97, 49], false, &mut budget)
            .unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|matched| (
                    matched.captures.clone(),
                    matched.index,
                    matched.groups.clone()
                ))
                .collect::<Vec<_>>(),
            vec![(vec![Some([49].to_vec())], 1, None)]
        );
        let replacements = vec![[49].to_vec()];
        let mut replacements = replacements.into_iter();
        assert_eq!(
            replace_matches(
                &[97, 49],
                &matches,
                |_| replacements.next().unwrap(),
                &mut budget
            )
            .unwrap(),
            [97, 49].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_21_stdlib_351() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_22_stdlib_355() {
    {
        let regex = RegExp::new(&[97, 43], "i").unwrap();
        assert_eq!(regex.source(), &[97, 43]);
        assert_eq!(regex.flags(), "i");
    }
    {
        let mut regex = RegExp::new(&[97, 43], "i").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(regex.test(&[65, 65, 65], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
    assert!(RegExp::new(&[40], "").is_err());
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_23_stdlib_361() {
    assert!(RegExp::new(&[40], "").is_err());
    assert!(RegExp::new(&[40], "").is_err());
    assert!(RegExp::new(&[97], "xz").is_err());
}

#[test]
fn corpus_24_stdlib_375() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_25_stdlib_386() {
    {
        let regex = RegExp::new(&[97, 98], "gi").unwrap();
        assert_eq!(regex.source(), &[97, 98]);
        assert_eq!(regex.flags(), "gi");
    }
}

#[test]
fn corpus_26_stdlib_394() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[97], "g").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "g");
    }
}

#[test]
fn corpus_27_stdlib_399() {
    {
        let regex = RegExp::new(&[97, 98], "g").unwrap();
        assert_eq!(regex.source(), &[97, 98]);
        assert_eq!(regex.flags(), "g");
    }
}

#[test]
fn corpus_28_stdlib_739() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[98, 97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 1,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[98, 97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 1,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_29_stdlib_861() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
}

#[test]
fn corpus_30_stdlib_876() {
    {
        let regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        assert_eq!(regex.source(), &[91, 97, 45, 122, 93, 43]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97, 32, 98], &mut budget).unwrap(),
            vec![
                Match {
                    captures: vec![Some([97].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([98].to_vec())],
                    index: 2,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        assert_eq!(regex.source(), &[91, 97, 45, 122, 93, 43]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[98, 32, 99], &mut budget).unwrap(),
            vec![
                Match {
                    captures: vec![Some([98].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([99].to_vec())],
                    index: 2,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        assert_eq!(regex.source(), &[91, 97, 45, 122, 93, 43]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[91, 97, 45, 122, 93, 43], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97], &mut budget).unwrap(),
            vec![Match {
                captures: vec![Some([97].to_vec())],
                index: 0,
                groups: None,
                indices: None,
                index_groups: None
            }]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_31_stdlib_1008() {
    {
        let regex = RegExp::new(&[97, 98, 43], "").unwrap();
        assert_eq!(regex.source(), &[97, 98, 43]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97, 98, 43], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(regex.test(&[97, 98, 98], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_32_regexp_math_test262_53() {
    assert_eq!(
        escape(&[49, 43, 49]),
        [92, 120, 51, 49, 92, 43, 49].to_vec()
    );
    assert_eq!(
        escape(&[102, 111, 111, 46, 98, 97, 114]),
        [92, 120, 54, 54, 111, 111, 92, 46, 98, 97, 114].to_vec()
    );
    assert_eq!(
        escape(&[46, 42, 43, 63, 94, 36, 124, 40, 41, 91, 93, 123, 125]),
        [
            92, 46, 92, 42, 92, 43, 92, 63, 92, 94, 92, 36, 92, 124, 92, 40, 92, 41, 92, 91, 92,
            93, 92, 123, 92, 125
        ]
        .to_vec()
    );
    assert_eq!(
        escape(&[44, 45, 61, 35, 38, 33, 37, 58, 59, 64, 126, 39]),
        [
            92, 120, 50, 99, 92, 120, 50, 100, 92, 120, 51, 100, 92, 120, 50, 51, 92, 120, 50, 54,
            92, 120, 50, 49, 92, 120, 50, 53, 92, 120, 51, 97, 92, 120, 51, 98, 92, 120, 52, 48,
            92, 120, 55, 101, 92, 120, 50, 55
        ]
        .to_vec()
    );
    assert_eq!(
        escape(&[9, 10, 11, 12, 13]),
        [92, 116, 92, 110, 92, 118, 92, 102, 92, 114].to_vec()
    );
    assert_eq!(
        escape(&[65279, 32, 160, 8239]),
        [
            92, 117, 102, 101, 102, 102, 92, 120, 50, 48, 92, 120, 97, 48, 92, 117, 50, 48, 50, 102
        ]
        .to_vec()
    );
    assert_eq!(
        escape(&[8232, 8233]),
        [92, 117, 50, 48, 50, 56, 92, 117, 50, 48, 50, 57].to_vec()
    );
    assert_eq!(escape(&[55296]), [92, 117, 100, 56, 48, 48].to_vec());
    assert_eq!(escape(&[57343]), [92, 117, 100, 102, 102, 102].to_vec());
}

#[test]
fn corpus_33_regexp_math_test262_97() {
    assert_eq!(escape(&[0u16; 0]), [0u16; 0].to_vec());
    assert_eq!(
        escape(&[46, 97, 49, 98, 50, 99, 51, 68, 52, 69, 53, 70, 54]),
        [92, 46, 97, 49, 98, 50, 99, 51, 68, 52, 69, 53, 70, 54].to_vec()
    );
    assert_eq!(
        escape(&[95, 97, 95, 49, 95, 50]),
        [95, 97, 95, 49, 95, 50].to_vec()
    );
    assert_eq!(
        escape(&[104, 101, 108, 108, 111, 95, 119, 111, 114, 108, 100]),
        [
            92, 120, 54, 56, 101, 108, 108, 111, 95, 119, 111, 114, 108, 100
        ]
        .to_vec()
    );
    assert_eq!(escape(&[47, 47]), [92, 47, 92, 47].to_vec());
    assert_eq!(escape(&[20320, 22909]), [20320, 22909].to_vec());
    assert_eq!(
        escape(&[915, 949, 953, 940, 32, 963, 959, 965]),
        [915, 949, 953, 940, 92, 120, 50, 48, 963, 959, 965].to_vec()
    );
    assert_eq!(escape(&[55349, 56321]), [55349, 56321].to_vec());
}

#[test]
fn corpus_34_regexp_math_test262_123() {
    {
        let regex = RegExp::new(&[40, 63, 60, 97, 62, 97, 41, 40, 98, 41, 63], "d").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 60, 97, 62, 97, 41, 40, 98, 41, 63]
        );
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 60, 97, 62, 97, 41, 40, 98, 41, 63], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec()), Some([97].to_vec()), None],
                index: 0,
                groups: Some(vec![([97].to_vec(), Some([97].to_vec()))]),
                indices: Some(vec![Some((0, 1)), Some((0, 1)), None]),
                index_groups: Some(vec![([97].to_vec(), Some((0, 1)))])
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97], "d").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[97], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([97].to_vec())],
                index: 0,
                groups: None,
                indices: Some(vec![Some((0, 1))]),
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97], "dg").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "dg");
    }
    {
        let mut regex = RegExp::new(&[97], "dg").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97, 32, 97], &mut budget).unwrap(),
            vec![
                Match {
                    captures: vec![Some([97].to_vec())],
                    index: 0,
                    groups: None,
                    indices: Some(vec![Some((0, 1))]),
                    index_groups: None
                },
                Match {
                    captures: vec![Some([97].to_vec())],
                    index: 2,
                    groups: None,
                    indices: Some(vec![Some((2, 3))]),
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "d",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41
            ]
        );
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "d",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97, 98], &mut budget).unwrap(),
            Some(Match {
                captures: vec![
                    Some([97, 98].to_vec()),
                    Some([97].to_vec()),
                    Some([98].to_vec())
                ],
                index: 0,
                groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some([97].to_vec())
                    ),
                    ([115, 97, 102, 101].to_vec(), Some([98].to_vec()))
                ]),
                indices: Some(vec![Some((0, 2)), Some((0, 1)), Some((1, 2))]),
                index_groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some((0, 1))
                    ),
                    ([115, 97, 102, 101].to_vec(), Some((1, 2)))
                ])
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[46], "d").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "d");
    }
    {
        let regex = RegExp::new(&[46], "d").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "d");
    }
}

#[test]
fn corpus_35_regexp_math_test262_147() {
    {
        let regex = RegExp::new(&[97], "").unwrap();
        assert_eq!(regex.source(), &[97]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[97], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 0,
                groups: None,
                indices: None,
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98, 40, 99, 41], "d").unwrap();
        assert_eq!(regex.source(), &[98, 40, 99, 41]);
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[98, 40, 99, 41], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97, 98, 99, 100], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([98, 99].to_vec()), Some([99].to_vec())],
                index: 1,
                groups: None,
                indices: Some(vec![Some((1, 3)), Some((2, 3))]),
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 92, 119, 92, 119, 41, 40, 92, 87, 41, 63], "d").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 92, 119, 92, 119, 41, 40, 92, 87, 41, 63]
        );
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[40, 92, 119, 92, 119, 41, 40, 92, 87, 41, 63], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[98, 97, 98], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([98, 97].to_vec()), Some([98, 97].to_vec()), None],
                index: 0,
                groups: None,
                indices: Some(vec![Some((0, 2)), Some((0, 2)), None]),
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "d").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[46], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[55349, 56321], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([55349].to_vec())],
                index: 0,
                groups: None,
                indices: Some(vec![Some((0, 1))]),
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "du").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "du");
    }
    {
        let mut regex = RegExp::new(&[46], "du").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[55349, 56321], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([55349, 56321].to_vec())],
                index: 0,
                groups: None,
                indices: Some(vec![Some((0, 2))]),
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "d").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(&[46], "d").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec())],
                index: 0,
                groups: None,
                indices: Some(vec![Some((0, 1))]),
                index_groups: None
            })
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_36_regexp_math_test262_180() {
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41,
            ],
            "d",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41
            ]
        );
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41,
            ],
            "d",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([97].to_vec()), Some([97].to_vec()), None],
                index: 0,
                groups: Some(vec![
                    ([97].to_vec(), Some([97].to_vec())),
                    ([120].to_vec(), None)
                ]),
                indices: Some(vec![Some((0, 1)), Some((0, 1)), None]),
                index_groups: Some(vec![([97].to_vec(), Some((0, 1))), ([120].to_vec(), None)])
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41,
            ],
            "dg",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41
            ]
        );
        assert_eq!(regex.flags(), "dg");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 97, 62, 97, 41, 124, 40, 63, 60, 120, 62, 120, 41,
            ],
            "dg",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97, 32, 120], &mut budget).unwrap(),
            vec![
                Match {
                    captures: vec![Some([97].to_vec()), Some([97].to_vec()), None],
                    index: 0,
                    groups: Some(vec![
                        ([97].to_vec(), Some([97].to_vec())),
                        ([120].to_vec(), None)
                    ]),
                    indices: Some(vec![Some((0, 1)), Some((0, 1)), None]),
                    index_groups: Some(vec![([97].to_vec(), Some((0, 1))), ([120].to_vec(), None)])
                },
                Match {
                    captures: vec![Some([120].to_vec()), None, Some([120].to_vec())],
                    index: 2,
                    groups: Some(vec![
                        ([97].to_vec(), None),
                        ([120].to_vec(), Some([120].to_vec()))
                    ]),
                    indices: Some(vec![Some((2, 3)), None, Some((2, 3))]),
                    index_groups: Some(vec![([97].to_vec(), None), ([120].to_vec(), Some((2, 3)))])
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "d",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41
            ]
        );
        assert_eq!(regex.flags(), "d");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "d",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.string_match(&[97, 98], &mut budget).unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![
                    Some([97, 98].to_vec()),
                    Some([97].to_vec()),
                    Some([98].to_vec())
                ],
                index: 0,
                groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some([97].to_vec())
                    ),
                    ([115, 97, 102, 101].to_vec(), Some([98].to_vec()))
                ]),
                indices: Some(vec![Some((0, 2)), Some((0, 1)), Some((1, 2))]),
                index_groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some((0, 1))
                    ),
                    ([115, 97, 102, 101].to_vec(), Some((1, 2)))
                ])
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "dg",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41
            ]
        );
        assert_eq!(regex.flags(), "dg");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 63, 60, 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114, 62, 97, 41, 40,
                63, 60, 115, 97, 102, 101, 62, 98, 41,
            ],
            "dg",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.match_all(&[97, 98], &mut budget).unwrap(),
            vec![Match {
                captures: vec![
                    Some([97, 98].to_vec()),
                    Some([97].to_vec()),
                    Some([98].to_vec())
                ],
                index: 0,
                groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some([97].to_vec())
                    ),
                    ([115, 97, 102, 101].to_vec(), Some([98].to_vec()))
                ]),
                indices: Some(vec![Some((0, 2)), Some((0, 1)), Some((1, 2))]),
                index_groups: Some(vec![
                    (
                        [99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114].to_vec(),
                        Some((0, 1))
                    ),
                    ([115, 97, 102, 101].to_vec(), Some((1, 2)))
                ])
            }]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_37_regexp_math_test262_201() {
    {
        let regex = RegExp::new(&[91, 97, 38, 38, 97, 93], "v").unwrap();
        assert_eq!(regex.source(), &[91, 97, 38, 38, 97, 93]);
        assert_eq!(regex.flags(), "v");
    }
    assert!(RegExp::new(&[46], "uv").is_err());
    {
        let mut regex = RegExp::new(&[91, 97, 38, 38, 97, 93], "v").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(regex.test(&[97], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[91, 97, 38, 38, 97, 93], "v").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert!(!regex.test(&[98], &mut budget).unwrap());
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_38_regexp_math_test262_216() {
    {
        let regex = RegExp::new(&[40, 63, 60, 97, 62, 91, 97, 38, 38, 97, 93, 41], "dv").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 60, 97, 62, 91, 97, 38, 38, 97, 93, 41]
        );
        assert_eq!(regex.flags(), "dv");
    }
    {
        let mut regex =
            RegExp::new(&[40, 63, 60, 97, 62, 91, 97, 38, 38, 97, 93, 41], "dv").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.exec(&[97], &mut budget).unwrap(),
            Some(Match {
                captures: vec![Some([97].to_vec()), Some([97].to_vec())],
                index: 0,
                groups: Some(vec![([97].to_vec(), Some([97].to_vec()))]),
                indices: Some(vec![Some((0, 1)), Some((0, 1))]),
                index_groups: Some(vec![([97].to_vec(), Some((0, 1)))])
            })
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_39_string_regexp_test262_111() {
    {
        let regex = RegExp::new(&[94], "").unwrap();
        assert_eq!(regex.source(), &[94]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[94], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[36], "").unwrap();
        assert_eq!(regex.source(), &[36]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[36], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 63], "").unwrap();
        assert_eq!(regex.source(), &[46, 63]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 42], "").unwrap();
        assert_eq!(regex.source(), &[46, 42]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 42], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 43], "").unwrap();
        assert_eq!(regex.source(), &[46, 43]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 43], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 42, 63], "").unwrap();
        assert_eq!(regex.source(), &[46, 42, 63]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 42, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 123, 49, 125], "").unwrap();
        assert_eq!(regex.source(), &[46, 123, 49, 125]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 123, 49, 125], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 123, 49, 44, 125], "").unwrap();
        assert_eq!(regex.source(), &[46, 123, 49, 44, 125]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 123, 49, 44, 125], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46, 123, 49, 44, 50, 125], "").unwrap();
        assert_eq!(regex.source(), &[46, 123, 49, 44, 50, 125]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46, 123, 49, 44, 50, 125], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 41], "").unwrap();
        assert_eq!(regex.source(), &[40, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[46], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 46, 46, 46, 41], "").unwrap();
        assert_eq!(regex.source(), &[40, 46, 46, 46, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 46, 46, 46, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 124, 41], "").unwrap();
        assert_eq!(regex.source(), &[40, 124, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 124, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 93], "").unwrap();
        assert_eq!(regex.source(), &[91, 93]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[91, 93], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 94, 93], "").unwrap();
        assert_eq!(regex.source(), &[91, 94, 93]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[91, 94, 93], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 46, 45, 46, 93], "").unwrap();
        assert_eq!(regex.source(), &[91, 46, 45, 46, 93]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[91, 46, 45, 46, 93], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 48], "").unwrap();
        assert_eq!(regex.source(), &[92, 48]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 48], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 98], "").unwrap();
        assert_eq!(regex.source(), &[92, 98]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 98], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 66], "").unwrap();
        assert_eq!(regex.source(), &[92, 66]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 66], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 100], "").unwrap();
        assert_eq!(regex.source(), &[92, 100]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 68], "").unwrap();
        assert_eq!(regex.source(), &[92, 68]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 68], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 110], "").unwrap();
        assert_eq!(regex.source(), &[92, 110]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 110], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 114], "").unwrap();
        assert_eq!(regex.source(), &[92, 114]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 114], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 115], "").unwrap();
        assert_eq!(regex.source(), &[92, 115]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 115], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 83], "").unwrap();
        assert_eq!(regex.source(), &[92, 83]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 83], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 118], "").unwrap();
        assert_eq!(regex.source(), &[92, 118]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 118], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 119], "").unwrap();
        assert_eq!(regex.source(), &[92, 119]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 119], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([0u16; 0].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 87], "").unwrap();
        assert_eq!(regex.source(), &[92, 87]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 87], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[120], 4294967295, &mut budget).unwrap(),
            vec![Some([120].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_40_string_regexp_test262_130() {
    {
        let regex = RegExp::new(&[92, 115], "").unwrap();
        assert_eq!(regex.source(), &[92, 115]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 115], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[97, 32, 98, 32, 99, 32, 100, 101, 32, 102], 3, &mut budget)
                .unwrap(),
            vec![
                Some([97].to_vec()),
                Some([98].to_vec()),
                Some([99].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_41_string_regexp_test262_135() {
    {
        let regex = RegExp::new(&[92, 115], "").unwrap();
        assert_eq!(regex.source(), &[92, 115]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 115], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[97, 32, 98, 32, 99, 32, 100, 101, 32, 102],
                    4294967295,
                    &mut budget
                )
                .unwrap(),
            vec![
                Some([97].to_vec()),
                Some([98].to_vec()),
                Some([99].to_vec()),
                Some([100, 101].to_vec()),
                Some([102].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_42_string_regexp_test262_140() {
    {
        let regex = RegExp::new(&[92, 100, 43], "").unwrap();
        assert_eq!(regex.source(), &[92, 100, 43]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 43], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[
                        100, 102, 101, 50, 51, 105, 117, 32, 51, 52, 32, 61, 43, 54, 53, 45, 45
                    ],
                    4294967295,
                    &mut budget
                )
                .unwrap(),
            vec![
                Some([100, 102, 101].to_vec()),
                Some([105, 117, 32].to_vec()),
                Some([32, 61, 43].to_vec()),
                Some([45, 45].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_43_string_regexp_test262_145() {
    {
        let regex = RegExp::new(&[92, 100, 43], "").unwrap();
        assert_eq!(regex.source(), &[92, 100, 43]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 43], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[
                        100, 102, 101, 50, 51, 105, 117, 32, 51, 52, 32, 61, 43, 54, 53, 45, 45
                    ],
                    4294967295,
                    &mut budget
                )
                .unwrap(),
            vec![
                Some([100, 102, 101].to_vec()),
                Some([105, 117, 32].to_vec()),
                Some([32, 61, 43].to_vec()),
                Some([45, 45].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_44_string_regexp_test262_150() {
    {
        let regex = RegExp::new(&[91, 97, 45, 122, 93], "").unwrap();
        assert_eq!(regex.source(), &[91, 97, 45, 122, 93]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[91, 97, 45, 122, 93], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[97, 98, 99], 4294967295, &mut budget).unwrap(),
            vec![
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_45_string_regexp_test262_155() {
    {
        let regex = RegExp::new(&[91, 97, 45, 122, 93], "").unwrap();
        assert_eq!(regex.source(), &[91, 97, 45, 122, 93]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[91, 97, 45, 122, 93], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex.split(&[97, 98, 99], 4294967295, &mut budget).unwrap(),
            vec![
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([0u16; 0].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_46_string_regexp_test262_160() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4294967295, &mut budget)
                .unwrap(),
            vec![
                Some([104, 101].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_47_string_regexp_test262_165() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 0, &mut budget)
                .unwrap(),
            vec![]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_48_string_regexp_test262_170() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 1, &mut budget)
                .unwrap(),
            vec![Some([104, 101].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_49_string_regexp_test262_175() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 2, &mut budget)
                .unwrap(),
            vec![Some([104, 101].to_vec()), Some([0u16; 0].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_50_string_regexp_test262_180() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 3, &mut budget)
                .unwrap(),
            vec![
                Some([104, 101].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_51_string_regexp_test262_185() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4, &mut budget)
                .unwrap(),
            vec![
                Some([104, 101].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_52_string_regexp_test262_190() {
    {
        let regex = RegExp::new(&[108], "").unwrap();
        assert_eq!(regex.source(), &[108]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[108], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4294967295, &mut budget)
                .unwrap(),
            vec![
                Some([104, 101].to_vec()),
                Some([0u16; 0].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_53_string_regexp_test262_195() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4294967295, &mut budget)
                .unwrap(),
            vec![
                Some([104].to_vec()),
                Some([101].to_vec()),
                Some([108].to_vec()),
                Some([108].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_54_string_regexp_test262_200() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 0, &mut budget)
                .unwrap(),
            vec![]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_55_string_regexp_test262_205() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 1, &mut budget)
                .unwrap(),
            vec![Some([104].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_56_string_regexp_test262_210() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 2, &mut budget)
                .unwrap(),
            vec![Some([104].to_vec()), Some([101].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_57_string_regexp_test262_215() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 3, &mut budget)
                .unwrap(),
            vec![
                Some([104].to_vec()),
                Some([101].to_vec()),
                Some([108].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_58_string_regexp_test262_220() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4, &mut budget)
                .unwrap(),
            vec![
                Some([104].to_vec()),
                Some([101].to_vec()),
                Some([108].to_vec()),
                Some([108].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_59_string_regexp_test262_225() {
    {
        let regex = RegExp::new(&[0u16; 0], "").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(&[104, 101, 108, 108, 111], 4294967295, &mut budget)
                .unwrap(),
            vec![
                Some([104].to_vec()),
                Some([101].to_vec()),
                Some([108].to_vec()),
                Some([108].to_vec()),
                Some([111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_60_string_regexp_test262_230() {
    {
        let regex = RegExp::new(&[32], "").unwrap();
        assert_eq!(regex.source(), &[32]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[32], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[
                        111, 110, 101, 32, 116, 119, 111, 32, 116, 104, 114, 101, 101, 32, 102,
                        111, 117, 114, 32, 102, 105, 118, 101
                    ],
                    2,
                    &mut budget
                )
                .unwrap(),
            vec![
                Some([111, 110, 101].to_vec()),
                Some([116, 119, 111].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_61_string_regexp_test262_235() {
    {
        let regex = RegExp::new(&[44], "").unwrap();
        assert_eq!(regex.source(), &[44]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[44], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[
                        111, 110, 101, 45, 49, 44, 116, 119, 111, 45, 50, 44, 102, 111, 117, 114,
                        45, 52
                    ],
                    4294967295,
                    &mut budget
                )
                .unwrap(),
            vec![
                Some([111, 110, 101, 45, 49].to_vec()),
                Some([116, 119, 111, 45, 50].to_vec()),
                Some([102, 111, 117, 114, 45, 52].to_vec())
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_62_string_regexp_test262_240() {
    {
        let regex = RegExp::new(&[88], "").unwrap();
        assert_eq!(regex.source(), &[88]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[88], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .split(
                    &[97, 32, 98, 32, 99, 32, 100, 101, 32, 102],
                    4294967295,
                    &mut budget
                )
                .unwrap(),
            vec![Some([97, 32, 98, 32, 99, 32, 100, 101, 32, 102].to_vec())]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_63_string_regexp_test262_248() {
    {
        let regex = RegExp::new(&[120], "").unwrap();
        assert_eq!(regex.source(), &[120]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[40, 120, 41], "").unwrap();
        assert_eq!(regex.source(), &[40, 120, 41]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        assert_eq!(regex.source(), &[40, 120, 41, 40, 36, 94, 41, 63]);
        assert_eq!(regex.flags(), "");
    }
    {
        let regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 49, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 49, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 49, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 50, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 50, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 50, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 48, 50, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 48, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 49, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 49, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 49, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[120], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 36, 50, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(&[40, 120, 41, 40, 36, 94, 41, 63], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 120, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[102, 111, 111, 45, 120, 45, 98, 97, 114],
                    &[124, 36, 50, 48, 48, 124],
                    &mut budget
                )
                .unwrap(),
            [102, 111, 111, 45, 124, 120, 48, 48, 124, 45, 98, 97, 114].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_64_string_regexp_test262_272() {
    {
        let regex = RegExp::new(&[0u16; 0], "g").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(&[97, 115, 100, 102], &[49], &mut budget)
                .unwrap(),
            [49, 97, 49, 115, 49, 100, 49, 102, 49].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_65_string_regexp_test262_277() {
    {
        let regex = RegExp::new(&[115, 104], "g").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 99, 104, 101,
                108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 99, 104, 111,
                114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_66_string_regexp_test262_282() {
    {
        let regex = RegExp::new(&[115, 104], "g").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 36, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 36, 115, 99, 104, 101,
                108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 36, 115, 99, 104,
                111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_67_string_regexp_test262_287() {
    {
        let regex = RegExp::new(&[115, 104], "g").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 38, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 115, 99,
                104, 101, 108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115,
                104, 115, 99, 104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_68_string_regexp_test262_292() {
    {
        let regex = RegExp::new(&[115, 104], "g").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 96, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 83, 104, 101, 32, 115,
                101, 108, 108, 115, 32, 115, 101, 97, 115, 99, 104, 101, 108, 108, 115, 32, 98,
                121, 32, 116, 104, 101, 32, 115, 101, 97, 83, 104, 101, 32, 115, 101, 108, 108,
                115, 32, 115, 101, 97, 115, 104, 101, 108, 108, 115, 32, 98, 121, 32, 116, 104,
                101, 32, 115, 101, 97, 115, 99, 104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_69_string_regexp_test262_297() {
    {
        let regex = RegExp::new(&[115, 104], "g").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 39, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 101, 108, 108, 115,
                32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104, 111, 114, 101, 46, 115,
                99, 104, 101, 108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 111,
                114, 101, 46, 115, 99, 104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_70_string_regexp_test262_302() {
    {
        let regex = RegExp::new(&[115, 104], "").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 99, 104, 101,
                108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104, 111,
                114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_71_string_regexp_test262_307() {
    {
        let regex = RegExp::new(&[115, 104], "").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 36, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 36, 115, 99, 104, 101,
                108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104, 111,
                114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_72_string_regexp_test262_312() {
    {
        let regex = RegExp::new(&[115, 104], "").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 38, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 115, 99,
                104, 101, 108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115,
                104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_73_string_regexp_test262_317() {
    {
        let regex = RegExp::new(&[115, 104], "").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 96, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 83, 104, 101, 32, 115,
                101, 108, 108, 115, 32, 115, 101, 97, 115, 99, 104, 101, 108, 108, 115, 32, 98,
                121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_74_string_regexp_test262_322() {
    {
        let regex = RegExp::new(&[115, 104], "").unwrap();
        assert_eq!(regex.source(), &[115, 104]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 104], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 115, 104, 101,
                        108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104,
                        111, 114, 101, 46
                    ],
                    &[36, 39, 115, 99, 104],
                    &mut budget
                )
                .unwrap(),
            [
                83, 104, 101, 32, 115, 101, 108, 108, 115, 32, 115, 101, 97, 101, 108, 108, 115,
                32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115, 104, 111, 114, 101, 46, 115,
                99, 104, 101, 108, 108, 115, 32, 98, 121, 32, 116, 104, 101, 32, 115, 101, 97, 115,
                104, 111, 114, 101, 46
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_75_string_regexp_test262_327() {
    {
        let regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[117, 105, 100, 61, 51, 49],
                    &[36, 49, 49, 49, 53],
                    &mut budget
                )
                .unwrap(),
            [117, 105, 100, 61, 49, 49, 53].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_76_string_regexp_test262_332() {
    {
        let regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[117, 105, 100, 61, 51, 49],
                    &[36, 49, 49, 49, 53],
                    &mut budget
                )
                .unwrap(),
            [117, 105, 100, 61, 49, 49, 53].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_77_string_regexp_test262_337() {
    {
        let regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[40, 117, 105, 100, 61, 41, 40, 92, 100, 43, 41], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[117, 105, 100, 61, 51, 49],
                    &[36, 49, 49, 65, 49, 53],
                    &mut budget
                )
                .unwrap(),
            [117, 105, 100, 61, 49, 65, 49, 53].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_78_string_regexp_test262_342() {
    {
        let regex = RegExp::new(&[94, 40, 97, 43, 41, 92, 49, 42, 44, 92, 49, 43, 36], "").unwrap();
        assert_eq!(
            regex.source(),
            &[94, 40, 97, 43, 41, 92, 49, 42, 44, 92, 49, 43, 36]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex =
            RegExp::new(&[94, 40, 97, 43, 41, 92, 49, 42, 44, 92, 49, 43, 36], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace(
                    &[
                        97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 44, 97, 97, 97, 97, 97, 97, 97, 97,
                        97, 97, 97, 97, 97, 97, 97
                    ],
                    &[36, 49],
                    &mut budget
                )
                .unwrap(),
            [97, 97, 97, 97, 97].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_79_string_regexp_test262_350() {
    {
        let regex = RegExp::new(&[98], "g").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[98], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 32, 97, 98, 99, 32, 97, 98, 99],
                    &[122],
                    &mut budget
                )
                .unwrap(),
            [97, 122, 99, 32, 97, 122, 99, 32, 97, 122, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98], "gy").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "gy");
    }
    {
        let mut regex = RegExp::new(&[98], "gy").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 32, 97, 98, 99, 32, 97, 98, 99],
                    &[122],
                    &mut budget
                )
                .unwrap(),
            [97, 98, 99, 32, 97, 98, 99, 32, 97, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98], "giy").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "giy");
    }
    {
        let mut regex = RegExp::new(&[98], "giy").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 32, 97, 98, 99, 32, 97, 98, 99],
                    &[122],
                    &mut budget
                )
                .unwrap(),
            [97, 98, 99, 32, 97, 98, 99, 32, 97, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 65, 45, 90, 93], "g").unwrap();
        assert_eq!(regex.source(), &[91, 65, 45, 90, 93]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[91, 65, 45, 90, 93], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[78, 111, 32, 85, 112, 112, 101, 114, 99, 97, 115, 101, 33],
                    &[0u16; 0],
                    &mut budget
                )
                .unwrap(),
            [111, 32, 112, 112, 101, 114, 99, 97, 115, 101, 33].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 65, 45, 90, 93], "gy").unwrap();
        assert_eq!(regex.source(), &[91, 65, 45, 90, 93]);
        assert_eq!(regex.flags(), "gy");
    }
    {
        let mut regex = RegExp::new(&[91, 65, 45, 90, 93], "gy").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[78, 111, 32, 85, 112, 112, 101, 114, 99, 97, 115, 101, 63],
                    &[0u16; 0],
                    &mut budget
                )
                .unwrap(),
            [111, 32, 85, 112, 112, 101, 114, 99, 97, 115, 101, 63].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[91, 65, 45, 90, 93], "gy").unwrap();
        assert_eq!(regex.source(), &[91, 65, 45, 90, 93]);
        assert_eq!(regex.flags(), "gy");
    }
    {
        let mut regex = RegExp::new(&[91, 65, 45, 90, 93], "gy").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[78, 79, 32, 85, 80, 80, 69, 82, 67, 65, 83, 69, 33],
                    &[0u16; 0],
                    &mut budget
                )
                .unwrap(),
            [32, 85, 80, 80, 69, 82, 67, 65, 83, 69, 33].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[36, 50, 45, 36, 49],
                    &mut budget
                )
                .unwrap(),
            [99, 97, 45, 98, 98, 99, 99, 97, 45, 98, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 97, 40, 46, 41, 41], "g").unwrap();
        assert_eq!(regex.source(), &[40, 97, 40, 46, 41, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[40, 97, 40, 46, 41, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[36, 49, 36, 50, 36, 51],
                    &mut budget
                )
                .unwrap(),
            [
                97, 98, 98, 36, 51, 99, 97, 98, 98, 36, 51, 99, 97, 98, 98, 36, 51, 99, 97, 98, 98,
                36, 51, 99
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 97, 40, 46, 41, 46, 41, 46, 41,
                46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 41, 41, 41, 41, 41,
            ],
            "g",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 97, 40, 46, 41, 46, 41, 46, 41,
                46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 41, 41, 41, 41, 41
            ]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 97, 40, 46, 41, 46, 41, 46, 41,
                46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 46, 41, 41, 41, 41, 41, 41,
            ],
            "g",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[
                        97, 97, 98, 97, 99, 97, 100, 97, 101, 97, 102, 97, 103, 97, 104, 97, 105,
                        97, 106, 97, 107, 97, 108, 97, 109, 97, 110, 111, 32, 97, 32, 97, 122, 97,
                        121, 97
                    ],
                    &[
                        40, 36, 49, 48, 41, 45, 40, 36, 49, 50, 41, 45, 40, 36, 49, 41
                    ],
                    &mut budget
                )
                .unwrap(),
            [
                40, 97, 97, 98, 97, 99, 97, 41, 45, 40, 97, 97, 98, 97, 41, 45, 40, 97, 97, 98, 97,
                99, 97, 100, 97, 101, 97, 41, 102, 40, 97, 103, 97, 104, 97, 105, 41, 45, 40, 97,
                103, 97, 104, 41, 45, 40, 97, 103, 97, 104, 97, 105, 97, 106, 97, 107, 41, 40, 97,
                108, 97, 109, 97, 110, 41, 45, 40, 97, 108, 97, 109, 41, 45, 40, 97, 108, 97, 109,
                97, 110, 111, 32, 97, 32, 41, 97, 122, 97, 121, 97
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98], "g").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[98], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(&[97, 98, 99, 98, 97], &[36, 39], &mut budget)
                .unwrap(),
            [97, 99, 98, 97, 99, 97, 97].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[98], "g").unwrap();
        assert_eq!(regex.source(), &[98]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[98], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(&[97, 98, 99, 98, 97], &[36, 96], &mut budget)
                .unwrap(),
            [97, 97, 99, 97, 98, 99, 97].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex =
            RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 98, 97],
                    &[40, 36, 60, 110, 97, 109, 101, 100, 62, 41],
                    &mut budget
                )
                .unwrap(),
            [97, 40, 98, 41, 99, 40, 98, 41, 97].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex =
            RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 98, 97],
                    &[40, 36, 60, 110, 97, 109, 101, 100, 41],
                    &mut budget
                )
                .unwrap(),
            [
                97, 40, 36, 60, 110, 97, 109, 101, 100, 41, 99, 40, 36, 60, 110, 97, 109, 101, 100,
                41, 97
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        assert_eq!(
            regex.source(),
            &[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex =
            RegExp::new(&[40, 63, 60, 110, 97, 109, 101, 100, 62, 98, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 98, 97],
                    &[40, 36, 60, 117, 110, 110, 97, 109, 101, 100, 62, 41],
                    &mut budget
                )
                .unwrap(),
            [97, 40, 41, 99, 40, 41, 97].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 41, 98, 99, 40, 36, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 41, 98, 99, 40, 36, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 36, 36, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 36, 41, 98, 99, 40, 36, 36, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 36, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 36, 41, 98, 99, 40, 36, 36, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 38, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 38, 41, 98, 99, 40, 36, 38, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 49, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 49, 41, 98, 99, 40, 36, 49, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 96, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 96, 41, 98, 99, 40, 36, 96, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 39, 41],
                    &mut budget
                )
                .unwrap(),
            [40, 36, 39, 41, 98, 99, 40, 36, 39, 41, 98, 99].to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 63, 60, 122, 62, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(
            regex.source(),
            &[97, 40, 63, 60, 122, 62, 98, 41, 40, 99, 97, 41]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex =
            RegExp::new(&[97, 40, 63, 60, 122, 62, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 36, 60, 122, 62, 41],
                    &mut budget
                )
                .unwrap(),
            [
                40, 36, 60, 122, 62, 41, 98, 99, 40, 36, 60, 122, 62, 41, 98, 99
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        assert_eq!(regex.source(), &[97, 40, 98, 41, 40, 99, 97, 41]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[97, 40, 98, 41, 40, 99, 97, 41], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .replace_all(
                    &[97, 98, 99, 97, 98, 99, 97, 98, 99, 97, 98, 99],
                    &[40, 36, 38, 41],
                    &mut budget
                )
                .unwrap(),
            [
                40, 97, 98, 99, 97, 41, 98, 99, 40, 97, 98, 99, 97, 41, 98, 99
            ]
            .to_vec()
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_80_string_regexp_test262_497() {
    {
        let regex = RegExp::new(&[55, 55], "").unwrap();
        assert_eq!(regex.source(), &[55, 55]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[55, 55], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[65, 66, 66, 65, 66, 65, 66, 65, 66, 55, 55, 66, 66, 65, 65],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![Some([55, 55].to_vec())],
                index: 9,
                groups: None,
                indices: None,
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_81_string_regexp_test262_502() {
    {
        let regex = RegExp::new(&[51, 52], "g").unwrap();
        assert_eq!(regex.source(), &[51, 52]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[51, 52], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(&[51, 52, 51, 52, 52, 51, 52, 52, 52], &mut budget)
                .unwrap(),
            Some(StringMatch::Global(vec![
                [51, 52].to_vec(),
                [51, 52].to_vec(),
                [51, 52].to_vec()
            ]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_82_string_regexp_test262_507() {
    {
        let regex = RegExp::new(&[92, 100, 123, 49, 125], "g").unwrap();
        assert_eq!(regex.source(), &[92, 100, 123, 49, 125]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 123, 49, 125], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[49, 50, 51, 52, 53, 54, 97, 98, 99, 100, 101, 55, 56, 57, 48],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Global(vec![
                [49].to_vec(),
                [50].to_vec(),
                [51].to_vec(),
                [52].to_vec(),
                [53].to_vec(),
                [54].to_vec(),
                [55].to_vec(),
                [56].to_vec(),
                [57].to_vec(),
                [48].to_vec()
            ]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_83_string_regexp_test262_512() {
    {
        let regex = RegExp::new(&[92, 100, 123, 50, 125], "g").unwrap();
        assert_eq!(regex.source(), &[92, 100, 123, 50, 125]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 100, 123, 50, 125], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[49, 50, 51, 52, 53, 54, 97, 98, 99, 100, 101, 55, 56, 57, 48],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Global(vec![
                [49, 50].to_vec(),
                [51, 52].to_vec(),
                [53, 54].to_vec(),
                [55, 56].to_vec(),
                [57, 48].to_vec()
            ]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_84_string_regexp_test262_517() {
    {
        let regex = RegExp::new(&[92, 68, 123, 50, 125], "g").unwrap();
        assert_eq!(regex.source(), &[92, 68, 123, 50, 125]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[92, 68, 123, 50, 125], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[49, 50, 51, 52, 53, 54, 97, 98, 99, 100, 101, 55, 56, 57, 48],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Global(vec![
                [97, 98].to_vec(),
                [99, 100].to_vec()
            ]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_85_string_regexp_test262_522() {
    {
        let regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[
                        66, 111, 115, 116, 111, 110, 44, 32, 77, 97, 115, 115, 46, 32, 48, 50, 49,
                        51, 52
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![
                    Some([48, 50, 49, 51, 52].to_vec()),
                    Some([48, 50, 49, 51, 52].to_vec()),
                    None
                ],
                index: 14,
                groups: None,
                indices: None,
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_86_string_regexp_test262_527() {
    {
        let regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "g",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36
            ]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "g",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[
                        66, 111, 115, 116, 111, 110, 44, 32, 77, 97, 115, 115, 46, 32, 48, 50, 49,
                        51, 52
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Global(vec![[48, 50, 49, 51, 52].to_vec()]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_87_string_regexp_test262_532() {
    {
        let regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36
            ]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[
                        66, 111, 115, 116, 111, 110, 44, 32, 77, 65, 32, 48, 50, 49, 51, 52
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Single(Match {
                captures: vec![
                    Some([48, 50, 49, 51, 52].to_vec()),
                    Some([48, 50, 49, 51, 52].to_vec()),
                    None
                ],
                index: 11,
                groups: None,
                indices: None,
                index_groups: None
            }))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_88_string_regexp_test262_537() {
    {
        let regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "g",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36
            ]
        );
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(
            &[
                40, 91, 92, 100, 93, 123, 53, 125, 41, 40, 91, 45, 32, 93, 63, 91, 92, 100, 93,
                123, 52, 125, 41, 63, 36,
            ],
            "g",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .string_match(
                    &[
                        66, 111, 115, 116, 111, 110, 44, 32, 77, 65, 32, 48, 50, 49, 51, 52
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(StringMatch::Global(vec![[48, 50, 49, 51, 52].to_vec()]))
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_89_string_regexp_test262_545() {
    {
        let regex = RegExp::new(&[40, 63, 58, 41], "gu").unwrap();
        assert_eq!(regex.source(), &[40, 63, 58, 41]);
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(&[40, 63, 58, 41], "gu").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(
                    &[55362, 57271, 97, 55362, 57271, 98, 55362, 57271],
                    &mut budget
                )
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 2,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 5,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 6,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([0u16; 0].to_vec())],
                    index: 8,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[92, 80, 123, 65, 83, 67, 73, 73, 125], "gu").unwrap();
        assert_eq!(regex.source(), &[92, 80, 123, 65, 83, 67, 73, 73, 125]);
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(&[92, 80, 123, 65, 83, 67, 73, 73, 125], "gu").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(&[97, 55362, 57271, 98, 56319, 57343, 99], &mut budget)
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 1,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([56319, 57343].to_vec())],
                    index: 4,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[55362, 57271], "g").unwrap();
        assert_eq!(regex.source(), &[55362, 57271]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[55362, 57271], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(
                    &[55362, 57271, 97, 55362, 57271, 98, 55362, 57271],
                    &mut budget
                )
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 6,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[55362, 57271], "gu").unwrap();
        assert_eq!(regex.source(), &[55362, 57271]);
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(&[55362, 57271], "gu").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(
                    &[55362, 57271, 97, 55362, 57271, 98, 55362, 57271],
                    &mut budget
                )
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 6,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(
            &[
                92, 112, 123, 83, 99, 114, 105, 112, 116, 61, 72, 97, 110, 125,
            ],
            "gu",
        )
        .unwrap();
        assert_eq!(
            regex.source(),
            &[
                92, 112, 123, 83, 99, 114, 105, 112, 116, 61, 72, 97, 110, 125
            ]
        );
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(
            &[
                92, 112, 123, 83, 99, 114, 105, 112, 116, 61, 72, 97, 110, 125,
            ],
            "gu",
        )
        .unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(
                    &[55362, 57271, 97, 55362, 57271, 98, 55362, 57271],
                    &mut budget
                )
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 6,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[46], "gu").unwrap();
        assert_eq!(regex.source(), &[46]);
        assert_eq!(regex.flags(), "gu");
    }
    {
        let mut regex = RegExp::new(&[46], "gu").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .match_all(
                    &[55362, 57271, 97, 55362, 57271, 98, 55362, 57271],
                    &mut budget
                )
                .unwrap(),
            vec![
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 0,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([97].to_vec())],
                    index: 2,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 3,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([98].to_vec())],
                    index: 5,
                    groups: None,
                    indices: None,
                    index_groups: None
                },
                Match {
                    captures: vec![Some([55362, 57271].to_vec())],
                    index: 6,
                    groups: None,
                    indices: None,
                    index_groups: None
                }
            ]
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_90_string_regexp_test262_576() {
    {
        let regex = RegExp::new(&[55, 55], "").unwrap();
        assert_eq!(regex.source(), &[55, 55]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[55, 55], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[65, 66, 66, 65, 66, 65, 66, 65, 66, 55, 55, 66, 66, 65, 65],
                    &mut budget
                )
                .unwrap(),
            Some(9)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_91_string_regexp_test262_581() {
    {
        let regex = RegExp::new(&[115, 116, 114, 105, 110, 103], "").unwrap();
        assert_eq!(regex.source(), &[115, 116, 114, 105, 110, 103]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[115, 116, 114, 105, 110, 103], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[116, 101, 115, 116, 32, 115, 116, 114, 105, 110, 103],
                    &mut budget
                )
                .unwrap(),
            Some(5)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_92_string_regexp_test262_586() {
    {
        let regex = RegExp::new(&[83, 116, 114, 105, 110, 103], "").unwrap();
        assert_eq!(regex.source(), &[83, 116, 114, 105, 110, 103]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[83, 116, 114, 105, 110, 103], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[116, 101, 115, 116, 32, 115, 116, 114, 105, 110, 103],
                    &mut budget
                )
                .unwrap(),
            None
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_93_string_regexp_test262_591() {
    {
        let regex = RegExp::new(&[83, 116, 114, 105, 110, 103], "i").unwrap();
        assert_eq!(regex.source(), &[83, 116, 114, 105, 110, 103]);
        assert_eq!(regex.flags(), "i");
    }
    {
        let mut regex = RegExp::new(&[83, 116, 114, 105, 110, 103], "i").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[116, 101, 115, 116, 32, 115, 116, 114, 105, 110, 103],
                    &mut budget
                )
                .unwrap(),
            Some(5)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_94_string_regexp_test262_596() {
    {
        let regex = RegExp::new(&[70, 111, 117, 114], "").unwrap();
        assert_eq!(regex.source(), &[70, 111, 117, 114]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[70, 111, 117, 114], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        111, 110, 101, 32, 116, 119, 111, 32, 116, 104, 114, 101, 101, 32, 102,
                        111, 117, 114, 32, 102, 105, 118, 101
                    ],
                    &mut budget
                )
                .unwrap(),
            None
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_95_string_regexp_test262_601() {
    {
        let regex = RegExp::new(&[102, 111, 117, 114], "").unwrap();
        assert_eq!(regex.source(), &[102, 111, 117, 114]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[102, 111, 117, 114], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        111, 110, 101, 32, 116, 119, 111, 32, 116, 104, 114, 101, 101, 32, 102,
                        111, 117, 114, 32, 102, 105, 118, 101
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(14)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_96_string_regexp_test262_606() {
    {
        let regex = RegExp::new(&[110, 111, 116, 101, 120, 105, 115, 116], "").unwrap();
        assert_eq!(regex.source(), &[110, 111, 116, 101, 120, 105, 115, 116]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[110, 111, 116, 101, 120, 105, 115, 116], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[116, 101, 115, 116, 32, 115, 116, 114, 105, 110, 103],
                    &mut budget
                )
                .unwrap(),
            None
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_97_string_regexp_test262_611() {
    {
        let regex = RegExp::new(&[115, 116, 114, 105, 110, 103, 32, 112, 114, 111], "").unwrap();
        assert_eq!(
            regex.source(),
            &[115, 116, 114, 105, 110, 103, 32, 112, 114, 111]
        );
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex =
            RegExp::new(&[115, 116, 114, 105, 110, 103, 32, 112, 114, 111], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        116, 101, 115, 116, 32, 115, 116, 114, 105, 110, 103, 32, 112, 114, 111,
                        98, 101
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(5)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_98_string_regexp_test262_616() {
    {
        let regex = RegExp::new(&[116, 104, 101], "").unwrap();
        assert_eq!(regex.source(), &[116, 104, 101]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[116, 104, 101], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        112, 111, 119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111,
                        119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111, 119, 101,
                        114, 32, 111, 102, 32, 116, 104, 101, 32, 103, 114, 101, 97, 116, 32, 115,
                        119, 111, 114, 100
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(9)
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[116, 104, 101], "g").unwrap();
        assert_eq!(regex.source(), &[116, 104, 101]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[116, 104, 101], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        112, 111, 119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111,
                        119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111, 119, 101,
                        114, 32, 111, 102, 32, 116, 104, 101, 32, 103, 114, 101, 97, 116, 32, 115,
                        119, 111, 114, 100
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(9)
        );
        assert_eq!(regex.last_index, 0);
    }
}

#[test]
fn corpus_99_string_regexp_test262_621() {
    {
        let regex = RegExp::new(&[111, 102], "").unwrap();
        assert_eq!(regex.source(), &[111, 102]);
        assert_eq!(regex.flags(), "");
    }
    {
        let mut regex = RegExp::new(&[111, 102], "").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        112, 111, 119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111,
                        119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111, 119, 101,
                        114, 32, 111, 102, 32, 116, 104, 101, 32, 103, 114, 101, 97, 116, 32, 115,
                        119, 111, 114, 100
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(6)
        );
        assert_eq!(regex.last_index, 0);
    }
    {
        let regex = RegExp::new(&[111, 102], "g").unwrap();
        assert_eq!(regex.source(), &[111, 102]);
        assert_eq!(regex.flags(), "g");
    }
    {
        let mut regex = RegExp::new(&[111, 102], "g").unwrap();
        regex.last_index = 0;
        let mut budget = Budget::unlimited();
        assert_eq!(
            regex
                .search(
                    &[
                        112, 111, 119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111,
                        119, 101, 114, 32, 111, 102, 32, 116, 104, 101, 32, 112, 111, 119, 101,
                        114, 32, 111, 102, 32, 116, 104, 101, 32, 103, 114, 101, 97, 116, 32, 115,
                        119, 111, 114, 100
                    ],
                    &mut budget
                )
                .unwrap(),
            Some(6)
        );
        assert_eq!(regex.last_index, 0);
    }
}
