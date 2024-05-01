#![feature(thread_local)]
#![allow(clippy::mixed_attributes_style)]
#![warn(unsafe_op_in_unsafe_fn, clippy::undocumented_unsafe_blocks)]
#![no_std]

use core::cell::Cell;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[cfg(not(test))]
#[panic_handler]
fn panic(_panic: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

/// Buffer used to write mangled symbols to pass to [`demangle()`].
#[thread_local]
static MANGLED_BUFFER: [Cell<u8>; 1024] = [const { Cell::new(0) }; 1024];

#[no_mangle]
pub extern "C" fn mangled_buffer() -> *mut u8 {
    //! Returns a pointer to a buffer where mangled symbols can be written before calling
    //! [`demangle()`]. Up to [`mangled_buffer_len()`] bytes can be written to the buffer.

    MANGLED_BUFFER.as_ptr().cast_mut().cast()
}

#[no_mangle]
pub extern "C" fn mangled_buffer_len() -> usize {
    //! Returns the length of the buffer returned by [`mangled_buffer()`].

    MANGLED_BUFFER.len()
}

/// Buffer used to write demangled symbols in [`demangle()`].
#[thread_local]
static DEMANGLED_BUFFER: [Cell<u8>; 1024] = [const { Cell::new(0) }; 1024];

#[no_mangle]
pub extern "C" fn demangled_buffer() -> *const u8 {
    //! Returns a pointer to the buffer where demangled symbols are written with [`demangle()`].
    //!
    //! The buffer is guaranteed to be UTF-8 up to `size`, with `size` the last return value of
    //! [`demangle()`].

    DEMANGLED_BUFFER.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn demangle(mangled_len: usize) -> usize {
    //! Demangles a C++ symbol name, returning its size. The demangled symbol is written to a buffer
    //! which can be obtained with [`demangled_buffer()`].
    //!
    //! The symbol must have been previously written to the buffer returned by [`mangled_buffer()`].
    //!
    //! On failure or if `mangled_len == 0`, returns 0.

    debug_assert!(mangled_len <= MANGLED_BUFFER.len());

    if mangled_len == 0 {
        return 0;
    }

    // SAFETY: `MANGLED_BUFFER` is a buffer of `u8`s and caller guarantees that its size is
    // `mangled_len`.
    let mangled =
        unsafe { core::slice::from_raw_parts(MANGLED_BUFFER.as_ptr().cast(), mangled_len) };

    let Ok(symbol) = cpp_demangle::Symbol::new(mangled) else {
        return 0;
    };
    let mut writer = WriteDemangled {
        data: &DEMANGLED_BUFFER,
    };
    let options = cpp_demangle::DemangleOptions::new()
        .no_return_type()
        .hide_expression_literal_types();
    if symbol.structured_demangle(&mut writer, &options).is_err() {
        return 0;
    }

    DEMANGLED_BUFFER.len() - writer.data.len()
}

/// [`cpp_demangle::DemangleWrite`] implementation that writes the demangled string to a buffer of
/// fixed size.
struct WriteDemangled<'a> {
    data: &'a [Cell<u8>],
}

impl cpp_demangle::DemangleWrite for WriteDemangled<'_> {
    fn write_string(&mut self, s: &str) -> core::fmt::Result {
        // `data` is `Some` so we're writing the demangled string to the allocated buffer.
        let bytes = s.as_bytes();
        let write_len = core::cmp::min(bytes.len(), self.data.len());

        for (i, byte) in bytes.iter().copied().enumerate().take(write_len) {
            self.data[i].set(byte);
        }

        self.data = &self.data[write_len..];

        Ok(())
    }
}
