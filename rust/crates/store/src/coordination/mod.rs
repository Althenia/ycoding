use crate::session::codec;
mod operations;
mod tables;

pub use operations::{delete, members, members_in, remove_session};
pub use tables::{Group, GroupTable, Member, MemberTable};

pub const TABLES: &[crate::TableDeclaration] = &[
    crate::TableDeclaration::of::<GroupTable>(),
    crate::TableDeclaration::of::<MemberTable>(),
];
