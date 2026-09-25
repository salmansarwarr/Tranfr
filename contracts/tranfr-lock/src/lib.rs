// lib.rs — compiled when building with `library` or `native-simulator` feature.
// Re-exports everything from main.rs so the test harness can access error
// codes and since_cmp functions by name.

#![cfg_attr(not(feature = "library"), no_std)]
#![allow(special_module_name)]
#![allow(unused_attributes)]

#[cfg(feature = "library")]
mod main;
#[cfg(feature = "library")]
pub use main::program_entry;
#[cfg(feature = "library")]
pub use main::{
    ERR_ARGS_LEN, ERR_LOAD_SCRIPT, ERR_LOAD_WITNESS, ERR_OWNER_SIG, ERR_RECIPIENT_SIG,
    ERR_RELATIVE_SINCE, ERR_SINCE_NOT_ELIGIBLE, ERR_UNKNOWN_MODE, ERR_WITNESS_LEN,
};
#[cfg(feature = "library")]
pub use main::{epoch_number_with_fraction_cmp, recipient_path_eligible, since_value_satisfied};

extern crate alloc;
