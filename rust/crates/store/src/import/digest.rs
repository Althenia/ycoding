use std::io::Read;

pub(crate) struct Digest {
    state: [u32; 8],
    buffer: Vec<u8>,
    length: u64,
}

impl Digest {
    pub(crate) fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: Vec::with_capacity(64),
            length: 0,
        }
    }
    pub(crate) fn update(&mut self, mut bytes: &[u8]) {
        self.length += bytes.len() as u64;
        while !bytes.is_empty() {
            let take = (64 - self.buffer.len()).min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.buffer.len() == 64 {
                self.block();
                self.buffer.clear();
            }
        }
    }
    fn block(&mut self) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut words = [0u32; 64];
        for (i, chunk) in self.buffer.as_chunks::<4>().0.iter().enumerate() {
            words[i] = u32::from_be_bytes(*chunk);
        }
        for i in 16..64 {
            let a = words[i - 15];
            let b = words[i - 2];
            words[i] = words[i - 16]
                .wrapping_add(a.rotate_right(7) ^ a.rotate_right(18) ^ (a >> 3))
                .wrapping_add(words[i - 7])
                .wrapping_add(b.rotate_right(17) ^ b.rotate_right(19) ^ (b >> 10));
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let first = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let second = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(first);
            d = c;
            c = b;
            b = a;
            a = first.wrapping_add(second);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
    pub(crate) fn finish(mut self) -> String {
        let length = self.length * 8;
        self.update(&[0x80]);
        while self.buffer.len() != 56 {
            self.update(&[0]);
        }
        self.update(&length.to_be_bytes());
        self.state
            .iter()
            .map(|word| format!("{word:08x}"))
            .collect()
    }
    pub(super) fn record(&mut self, key: &[u8], value: &[u8]) {
        self.update(&(key.len() as u64).to_be_bytes());
        self.update(key);
        self.update(&(value.len() as u64).to_be_bytes());
        self.update(value);
    }
}

pub(super) fn file(path: &std::path::Path) -> Result<(String, i64), super::Error> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Digest::new();
    let mut buffer = [0; 65536];
    let mut length = 0i64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok((digest.finish(), length));
        }
        length = length
            .checked_add(count as i64)
            .ok_or(super::Error::Source("source size overflow"))?;
        digest.update(&buffer[..count]);
    }
}

#[test]
fn published_sha256_vectors_and_chunk_boundaries() {
    for (bytes, expected) in [
        (
            "",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            "abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ] {
        let mut digest = Digest::new();
        digest.update(bytes.as_bytes());
        assert_eq!(digest.finish(), expected);
    }
    let mut digest = Digest::new();
    for _ in 0..1000 {
        digest.update(&[b'a'; 1000]);
    }
    assert_eq!(
        digest.finish(),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
}
