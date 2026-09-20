/* libjpeg-turbo build number */
#define BUILD  "20260913"

/* Compiler's inline keyword */
#undef inline

/* How to obtain function inlining. */
#define INLINE  __inline__ __attribute__((always_inline))

/* How to obtain thread-local storage */
#define THREAD_LOCAL  __thread

/* Define to the full name of this package. */
#define PACKAGE_NAME  "libjpeg-turbo"

/* Version number of package */
#define VERSION  "2.1.5.1"

/* The size of `size_t', as computed by sizeof.
 * FIXED: this was hardcoded to 7 in the original build, which is not a
 * valid word size for jchuff.c's bit-buffer packing (it expects 4 or 8).
 * wasm32's size_t is 4 bytes -- see README.md "Known bug" section for the
 * corruption this caused and why the shipped libjpeg.a / jpegopt.wasm in
 * this repo must be rebuilt before trusting them on real images. */
#define SIZEOF_SIZE_T  4

/* Define if your compiler has __builtin_ctzl() and sizeof(unsigned long) == sizeof(size_t). */
#define HAVE_BUILTIN_CTZL

/* Define to 1 if you have the <intrin.h> header file. */
/* #undef HAVE_INTRIN_H */

#if defined(_MSC_VER) && defined(HAVE_INTRIN_H)
#if (SIZEOF_SIZE_T == 8)
#define HAVE_BITSCANFORWARD64
#elif (SIZEOF_SIZE_T == 4)
#define HAVE_BITSCANFORWARD
#endif
#endif

#if defined(__has_attribute)
#if __has_attribute(fallthrough)
#define FALLTHROUGH  __attribute__((fallthrough));
#else
#define FALLTHROUGH
#endif
#else
#define FALLTHROUGH
#endif
