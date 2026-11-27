use icu_normalizer::ComposingNormalizerBorrowed;
use tantivy::tokenizer::{
    LowerCaser, RemoveLongFilter, StopWordFilter, TextAnalyzer, Token, TokenStream, Tokenizer,
};

pub const ANALYZER: &str = "cue";
pub const REVISION: &str = "a3";
const MAX_TOKEN_BYTES: usize = 64;
const STOP_WORDS: &str = "a about after all also am an and any are as at be been before being both but by can could did do does down during each for from had has have he her his how i if in into is it its may might more most must my no not of off on only or other our out over own same she should so some such than that the their then there these they this to too under up very was we were what when where which who why will with would you your";

pub fn analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(WordTokenizer::default())
        .filter(RemoveLongFilter::limit(MAX_TOKEN_BYTES))
        .filter(LowerCaser)
        .filter(StopWordFilter::remove(
            STOP_WORDS.split(' ').map(str::to_owned),
        ))
        .build()
}

pub fn prepare(text: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(&text.to_lowercase())
        .into_owned()
}

pub fn normalize(text: &str) -> String {
    prepare(text.trim())
}

pub fn positioned(analyzer: &mut TextAnalyzer, text: &str) -> Vec<(usize, String)> {
    let normalized = prepare(text);
    let mut stream = analyzer.token_stream(&normalized);
    let mut out = Vec::new();
    while stream.advance() {
        let token = stream.token();
        out.push((token.position, token.text.clone()));
    }
    out
}

fn is_word(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

#[derive(Clone, Default)]
pub struct WordTokenizer {
    token: Token,
}

pub struct WordTokenStream<'a> {
    text: &'a str,
    chars: std::str::CharIndices<'a>,
    token: &'a mut Token,
}

impl Tokenizer for WordTokenizer {
    type TokenStream<'a> = WordTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> WordTokenStream<'a> {
        self.token.reset();
        WordTokenStream {
            text,
            chars: text.char_indices(),
            token: &mut self.token,
        }
    }
}

impl TokenStream for WordTokenStream<'_> {
    fn advance(&mut self) -> bool {
        self.token.text.clear();
        self.token.position = self.token.position.wrapping_add(1);
        while let Some((from, ch)) = self.chars.next() {
            if !is_word(ch) {
                continue;
            }
            let to = self
                .chars
                .find(|(_, c)| !is_word(*c))
                .map_or(self.text.len(), |(offset, _)| offset);
            self.token.offset_from = from;
            self.token.offset_to = to;
            self.token.text.push_str(&self.text[from..to]);
            return true;
        }
        false
    }

    fn token(&self) -> &Token {
        self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        self.token
    }
}
