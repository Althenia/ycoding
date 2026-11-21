use std::{
    io,
    sync::mpsc::{self, SyncSender},
    thread,
};

pub const CAPACITY: usize = 256;

enum Message<T> {
    Item(T),
    Flush(SyncSender<()>),
}

pub struct Queue<T> {
    sender: SyncSender<Message<T>>,
}

impl<T: Send + 'static> Queue<T> {
    pub fn spawn(capacity: usize, mut handle: impl FnMut(T) + Send + 'static) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        thread::Builder::new()
            .name("quota-alerts".into())
            .spawn(move || {
                for message in receiver {
                    match message {
                        Message::Item(item) => handle(item),
                        Message::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })?;
        Ok(Self { sender })
    }

    pub fn offer(&self, item: T) -> bool {
        self.sender.try_send(Message::Item(item)).is_ok()
    }

    pub fn flush(&self) {
        let (done, settled) = mpsc::sync_channel(0);
        if self.sender.send(Message::Flush(done)).is_ok() {
            let _ = settled.recv();
        }
    }
}
