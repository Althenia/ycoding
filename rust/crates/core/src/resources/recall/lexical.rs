use crate::resources::memory::{Error, format::tokens};
use std::{collections::BTreeSet, io::Read, path::Path, time::Instant};
use tantivy::directory::{Directory, RamDirectory};
use tantivy::{
    DocSet, HasLen, Index, IndexReader, TERMINATED, TantivyDocument, Term,
    postings::Postings,
    schema::{FAST, Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions},
};

pub(crate) struct Document<'a> {
    pub id: &'a str,
    pub title: String,
    pub metadata: String,
    pub tags: Vec<String>,
    pub body: &'a str,
}

impl Document<'_> {
    pub fn match_reason(
        &self,
        query: &str,
        terms: &[String],
    ) -> Result<Option<&'static str>, Error> {
        let equal = |text: &str| {
            icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(&text.to_lowercase())
                == query
        };
        Ok(if equal(self.id) {
            Some("exact-id")
        } else if equal(&self.title) {
            Some("exact-title")
        } else if self.tags.iter().any(|t| equal(t)) {
            Some("exact-tag")
        } else if terms.len() > 1 && tokens(self.body)?.windows(terms.len()).any(|w| w == terms) {
            Some("body-phrase")
        } else {
            None
        })
    }
}

pub(crate) struct Lexical {
    ram: RamDirectory,
    reader: IndexReader,
    fields: [Field; 3],
    lengths: Vec<[usize; 3]>,
    totals: [usize; 3],
}

impl Lexical {
    pub fn build(documents: &[Document<'_>]) -> Result<Self, Error> {
        static BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let deadline = Instant::now() + std::time::Duration::from_secs(60);
        let _building = BUILD.lock().map_err(|_| Error::Unavailable)?;
        if Instant::now() >= deadline {
            return Err(Error::TooLarge);
        }
        let mut schema = Schema::builder();
        let options = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("raw")
                .set_index_option(IndexRecordOption::WithFreqs),
        );
        let fields =
            ["title", "metadata", "body"].map(|name| schema.add_text_field(name, options.clone()));
        let ordinal = schema.add_u64_field("ordinal", FAST);
        let ram = RamDirectory::create();
        let index = Index::create(ram.clone(), schema.build(), Default::default())
            .map_err(|_| Error::Unavailable)?;
        let mut writer = index
            .writer_with_num_threads(1, 16_000_000)
            .map_err(|_| Error::Unavailable)?;
        writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        let mut lengths = Vec::with_capacity(documents.len());
        let mut totals = [0; 3];
        for (i, item) in documents.iter().enumerate() {
            if Instant::now() >= deadline {
                return Err(Error::TooLarge);
            }
            let mut doc = TantivyDocument::default();
            doc.add_u64(ordinal, i as u64);
            let title = format!("{} {}", item.title, item.id);
            let mut lens = [0; 3];
            for (j, text) in [title.as_str(), &item.metadata, item.body]
                .into_iter()
                .enumerate()
            {
                let words = tokens(text)?;
                lens[j] = words.len();
                totals[j] += words.len();
                for word in words {
                    doc.add_text(fields[j], word);
                }
            }
            lengths.push(lens);
            writer.add_document(doc).map_err(|_| Error::Unavailable)?;
        }
        writer.commit().map_err(|_| Error::Unavailable)?;
        writer
            .wait_merging_threads()
            .map_err(|_| Error::Unavailable)?;
        if Instant::now() >= deadline {
            return Err(Error::TooLarge);
        }
        let reader = index
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::Manual)
            .try_into()
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            ram,
            reader,
            fields,
            lengths,
            totals,
        })
    }

    pub fn pack(&self, generation: &str, limit: usize) -> Result<Vec<u8>, Error> {
        let mut archive = tar::Builder::new(Vec::new());
        let mut append = |path: &Path, bytes: &[u8]| -> Result<(), Error> {
            if archive
                .get_ref()
                .len()
                .saturating_add(1536)
                .saturating_add(bytes.len().div_ceil(512).saturating_mul(512))
                > limit
            {
                return Err(Error::TooLarge);
            }
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            archive.append_data(&mut header, path, bytes)?;
            Ok(())
        };
        let metadata =
            serde_json::to_vec(&(generation, &self.lengths)).map_err(|_| Error::Unavailable)?;
        append(Path::new("generation"), &metadata)?;
        let mut files: BTreeSet<_> = self
            .reader
            .searcher()
            .index()
            .directory()
            .list_managed_files()
            .into_iter()
            .collect();
        files.extend(["meta.json".into(), ".managed.json".into()]);
        for path in files {
            let file = self.ram.open_read(&path).map_err(|_| Error::Unavailable)?;
            if file.len() > limit {
                return Err(Error::TooLarge);
            }
            append(&path, file.read_bytes()?.as_slice())?;
        }
        Ok(archive.into_inner()?)
    }

    pub fn unpack(bytes: &[u8], generation: &str, count: usize) -> Option<Self> {
        let ram = RamDirectory::create();
        let mut archive = tar::Archive::new(bytes);
        let mut entries = archive.entries().ok()?;
        let mut header = entries.next()?.ok()?;
        if header.path().ok()?.as_ref() != Path::new("generation")
            || header.size() > count as u64 * 64 + 128
        {
            return None;
        }
        let (stamp, lengths): (String, Vec<[usize; 3]>) =
            serde_json::from_reader(&mut header).ok()?;
        if stamp != generation || lengths.len() != count {
            return None;
        }
        let mut totals = [0usize; 3];
        for lens in &lengths {
            for (i, n) in lens.iter().enumerate() {
                totals[i] = totals[i].checked_add(*n)?;
            }
        }
        for (i, entry) in entries.enumerate() {
            let mut entry = entry.ok()?;
            let path = entry.path().ok()?.into_owned();
            if i >= 512
                || path.components().count() != 1
                || !matches!(
                    path.components().next(),
                    Some(std::path::Component::Normal(_))
                )
                || !entry.header().entry_type().is_file()
                || entry.size() > bytes.len() as u64
            {
                return None;
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).ok()?;
            ram.atomic_write(&path, &data).ok()?;
        }
        let index = Index::open(ram.clone()).ok()?;
        if !index.validate_checksum().ok()?.is_empty() {
            return None;
        }
        let schema = index.schema();
        let fields = [
            schema.get_field("title").ok()?,
            schema.get_field("metadata").ok()?,
            schema.get_field("body").ok()?,
        ];
        let reader: IndexReader = index
            .reader_builder()
            .reload_policy(tantivy::ReloadPolicy::Manual)
            .try_into()
            .ok()?;
        if reader.searcher().num_docs() != count as u64 {
            return None;
        }
        Some(Self {
            ram,
            reader,
            fields,
            lengths,
            totals,
        })
    }

    pub fn scores(&self, terms: &BTreeSet<String>) -> Result<Vec<f64>, Error> {
        let n = self.lengths.len();
        let mut scores = vec![0.; n];
        let searcher = self.reader.searcher();
        for term in terms {
            let mut weights = vec![0.; n];
            for segment in searcher.segment_readers() {
                let ordinals = segment
                    .fast_fields()
                    .u64("ordinal")
                    .map_err(|_| Error::Unavailable)?;
                for (j, field) in self.fields.iter().enumerate() {
                    let inverted = segment
                        .inverted_index(*field)
                        .map_err(|_| Error::Unavailable)?;
                    let Some(mut docs) = inverted
                        .read_postings(
                            &Term::from_field_text(*field, term),
                            IndexRecordOption::WithFreqs,
                        )
                        .map_err(|_| Error::Unavailable)?
                    else {
                        continue;
                    };
                    while docs.doc() != TERMINATED {
                        let i = ordinals.first(docs.doc()).ok_or(Error::Unavailable)? as usize;
                        let len = *self.lengths.get(i).ok_or(Error::Unavailable)?;
                        let avg = self.totals[j] as f64 / n as f64;
                        weights[i] += field_weight(j, f64::from(docs.term_freq()), len[j], avg);
                        docs.advance();
                    }
                }
            }
            let df = weights.iter().filter(|w| **w > 0.).count();
            let idf = inverse_frequency(n, df);
            for (score, weight) in scores.iter_mut().zip(weights) {
                *score += idf * weight;
            }
        }
        Ok(scores)
    }
}

fn field_weight(field: usize, frequency: f64, length: usize, average: f64) -> f64 {
    [4., 2., 1.][field]
        * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length as f64 / average)))
}

fn inverse_frequency(count: usize, frequency: usize) -> f64 {
    (1. + ((count - frequency) as f64 + 0.5) / (frequency as f64 + 0.5)).ln()
}

pub(crate) fn bm25_scores(
    documents: &[Document<'_>],
    terms: &BTreeSet<String>,
) -> Result<Vec<f64>, Error> {
    Lexical::build(documents)?.scores(terms)
}
