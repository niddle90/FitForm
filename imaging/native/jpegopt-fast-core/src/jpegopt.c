/*
 * jpegopt-fast -- minimal, fast "hit a target JPEG size" tool.
 *
 * Why this is fast where the original wasn't:
 *   JPEG size vs. quality is monotonic (non-decreasing) for a fixed image,
 *   so finding the highest quality that still fits under a byte budget is a
 *   plain bisection on ENCODE alone -- no decode-back, no MS-SSIM, no
 *   multi-scale Gaussian pyramids. ~7 encode passes (log2(100)) instead of
 *   ~100 encode+decode+metric passes. Each encode of a several-megapixel
 *   image is a few tens of ms, so the whole search finishes in well under
 *   a second, single-threaded, which also happens to be exactly the
 *   execution model WASM is comfortable with (no SharedArrayBuffer /
 *   pthread ceremony needed).
 *
 * Dimension handling:
 *   --fixed-dimension          keep the source's native pixel size, ignore
 *                              --width/--height entirely.
 *   --width W                  scale so output width == W, height follows
 *                              the source aspect ratio exactly.
 *   --height H                 mirror of the above.
 *   --width W --height H       "cover" resize: scale the source up/down so
 *                              it fully covers the W x H box, then crop
 *                              whatever overflows past the edges, anchored
 *                              per --crop-anchor (default: center).
 *   (none of the above)        same as --fixed-dimension.
 *
 * ---------------------------------------------------------------------
 * Customization layer (added on top of the original core; everything in
 * this section defaults to the original engine's exact prior behavior,
 * so existing callers see no change unless they opt in):
 *
 *   --min-quality Q            quality floor before the autoscale fallback
 *                              gives up on this pass and shrinks pixels
 *                              instead. Default 20 (the original hardcoded
 *                              value). Lower it to squeeze harder for a
 *                              tight byte budget at the cost of visible
 *                              blocking; raise it to protect a quality
 *                              floor and shrink dimensions sooner instead.
 *   --max-scale-tries N        how many shrink-and-retry rounds the
 *                              autoscale fallback gets (only relevant when
 *                              dimensions aren't pinned). Default 5.
 *   --subsampling MODE         chroma subsampling: 444 (default, matches
 *                              the original engine exactly), 422, 420, or
 *                              411. Lower ratios trade fine color detail
 *                              for smaller files at a fixed quality --
 *                              useful when the byte budget is tight enough
 *                              that quality alone can't buy back the bytes
 *                              4:4:4 costs.
 *   --progressive              emit a progressive JPEG (multi-scan) instead
 *                              of baseline sequential. Off by default,
 *                              matching the original engine. Progressive
 *                              typically shaves a few percent off file size
 *                              at the same quality and renders top-to-
 *                              bottom at increasing fidelity, which is
 *                              usually a win for web delivery -- the
 *                              tradeoff is slightly slower decode.
 *   --crop-anchor ANCHOR       for the --width+--height "cover" mode only:
 *                              which part of the overflow to keep --
 *                              center (default, original behavior), top,
 *                              bottom, left, or right.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <setjmp.h>
#include <jpeglib.h>
#include <jerror.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

static void *xmalloc(size_t n)
{
    void *p = malloc(n);
    if (!p) { fprintf(stderr, "out of memory (%zu bytes)\n", n); exit(1); }
    return p;
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ------------------------------------------------------------------ */
/* libjpeg error handling: longjmp instead of the default exit()       */
/* ------------------------------------------------------------------ */
struct jpegopt_err { struct jpeg_error_mgr pub; jmp_buf jb; };

static void jpegopt_error_exit(j_common_ptr cinfo)
{
    struct jpegopt_err *e = (struct jpegopt_err *)cinfo->err;
    char buf[JMSG_LENGTH_MAX];
    (*cinfo->err->format_message)(cinfo, buf);
    fprintf(stderr, "[jpeg] %s\n", buf);
    longjmp(e->jb, 1);
}

/* ------------------------------------------------------------------ */
/* chroma subsampling modes                                             */
/* ------------------------------------------------------------------ */
typedef enum {
    SUBSAMPLE_444 = 0, /* no subsampling -- the original engine's only mode */
    SUBSAMPLE_422 = 1,
    SUBSAMPLE_420 = 2,
    SUBSAMPLE_411 = 3
} SubsampleMode;

static void apply_subsampling(struct jpeg_compress_struct *cinfo, SubsampleMode mode)
{
    int ch = 1, cv = 1; /* chroma (Cb/Cr) sampling factors relative to luma */
    switch (mode) {
        case SUBSAMPLE_422: ch = 2; cv = 1; break;
        case SUBSAMPLE_420: ch = 2; cv = 2; break;
        case SUBSAMPLE_411: ch = 4; cv = 1; break;
        case SUBSAMPLE_444: default: ch = 1; cv = 1; break;
    }
    cinfo->comp_info[0].h_samp_factor = ch;
    cinfo->comp_info[0].v_samp_factor = cv;
    cinfo->comp_info[1].h_samp_factor = 1;
    cinfo->comp_info[1].v_samp_factor = 1;
    cinfo->comp_info[2].h_samp_factor = 1;
    cinfo->comp_info[2].v_samp_factor = 1;
}

/* ------------------------------------------------------------------ */
/* decode                                                               */
/* ------------------------------------------------------------------ */
static unsigned char *decode_jpeg_mem(const unsigned char *buf, size_t len,
                                       int *w, int *h)
{
    struct jpeg_decompress_struct cinfo;
    struct jpegopt_err jerr;
    unsigned char *out = NULL;

    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpegopt_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_decompress(&cinfo);
        free(out);
        return NULL;
    }

    jpeg_create_decompress(&cinfo);
    jpeg_mem_src(&cinfo, (unsigned char *)buf, (unsigned long)len);
    jpeg_read_header(&cinfo, TRUE);
    cinfo.out_color_space = JCS_RGB;
    jpeg_start_decompress(&cinfo);

    *w = (int)cinfo.output_width;
    *h = (int)cinfo.output_height;
    out = xmalloc((size_t)(*w) * (size_t)(*h) * 3);

    while (cinfo.output_scanline < cinfo.output_height) {
        unsigned char *row = out + (size_t)cinfo.output_scanline * (*w) * 3;
        jpeg_read_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    return out;
}

/* ------------------------------------------------------------------ */
/* encode -- baseline or progressive, optimized Huffman tables, chroma  */
/* subsampling configurable (defaults to 4:4:4, the original engine's   */
/* only mode, which keeps fine colour detail at a small size cost).     */
/* ------------------------------------------------------------------ */
static unsigned char *encode_jpeg_mem(const unsigned char *rgb, int w, int h,
                                       int q, SubsampleMode subsample,
                                       int progressive, unsigned long *out_len)
{
    struct jpeg_compress_struct cinfo;
    struct jpegopt_err jerr;
    unsigned char *outbuf = NULL;
    *out_len = 0;

    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = jpegopt_error_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_compress(&cinfo);
        free(outbuf);
        return NULL;
    }

    jpeg_create_compress(&cinfo);
    jpeg_mem_dest(&cinfo, &outbuf, out_len);

    cinfo.image_width = w;
    cinfo.image_height = h;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, q, TRUE);
    cinfo.optimize_coding = TRUE;
    apply_subsampling(&cinfo, subsample);
    if (progressive) jpeg_simple_progression(&cinfo);

    jpeg_start_compress(&cinfo, TRUE);
    while (cinfo.next_scanline < (JDIMENSION)h) {
        JSAMPROW row = (JSAMPROW)&rgb[cinfo.next_scanline * w * 3];
        jpeg_write_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    return outbuf;
}

/* ------------------------------------------------------------------ */
/* resize -- separable bilinear. Good enough quality for a "basic,     */
/* fast" tool; swap for a Lanczos kernel later if you want sharper     */
/* downscales, the search/encode logic below doesn't care.             */
/* ------------------------------------------------------------------ */
static unsigned char *resize_bilinear(const unsigned char *src, int sw, int sh,
                                       int dw, int dh)
{
    unsigned char *dst = xmalloc((size_t)dw * dh * 3);
    float xr = (sw > 1 && dw > 1) ? (float)(sw - 1) / (float)(dw - 1) : 0.0f;
    float yr = (sh > 1 && dh > 1) ? (float)(sh - 1) / (float)(dh - 1) : 0.0f;

    for (int y = 0; y < dh; y++) {
        float sy = y * yr;
        int y0 = (int)sy, y1 = clampi(y0 + 1, 0, sh - 1);
        float fy = sy - y0;

        for (int x = 0; x < dw; x++) {
            float sx = x * xr;
            int x0 = (int)sx, x1 = clampi(x0 + 1, 0, sw - 1);
            float fx = sx - x0;

            const unsigned char *p00 = src + ((size_t)y0 * sw + x0) * 3;
            const unsigned char *p10 = src + ((size_t)y0 * sw + x1) * 3;
            const unsigned char *p01 = src + ((size_t)y1 * sw + x0) * 3;
            const unsigned char *p11 = src + ((size_t)y1 * sw + x1) * 3;

            unsigned char *o = dst + ((size_t)y * dw + x) * 3;
            for (int c = 0; c < 3; c++) {
                float top = p00[c] + (p10[c] - p00[c]) * fx;
                float bot = p01[c] + (p11[c] - p01[c]) * fx;
                float v   = top + (bot - top) * fy;
                o[c] = (unsigned char)(v + 0.5f);
            }
        }
    }
    return dst;
}

/* ------------------------------------------------------------------ */
/* crop -- anchored, not just centered. 0=center 1=top 2=bottom 3=left  */
/* 4=right (matches CropAnchor in the wasm/CLI surface below).          */
/* ------------------------------------------------------------------ */
static unsigned char *crop_anchored(const unsigned char *src, int sw, int sh,
                                     int cw, int ch, int anchor)
{
    unsigned char *dst = xmalloc((size_t)cw * ch * 3);
    int ox = (sw - cw) / 2, oy = (sh - ch) / 2; /* center, the default */

    switch (anchor) {
        case 1: oy = 0; break;              /* top    */
        case 2: oy = sh - ch; break;         /* bottom */
        case 3: ox = 0; break;               /* left   */
        case 4: ox = sw - cw; break;         /* right  */
        default: break;                      /* center */
    }
    ox = clampi(ox, 0, sw - cw);
    oy = clampi(oy, 0, sh - ch);

    for (int y = 0; y < ch; y++)
        memcpy(dst + (size_t)y * cw * 3,
               src + ((size_t)(y + oy) * sw + ox) * 3,
               (size_t)cw * 3);
    return dst;
}

/* ------------------------------------------------------------------ */
/* dimension planning                                                   */
/* ------------------------------------------------------------------ */
static unsigned char *plan_dimensions(unsigned char *src, int sw, int sh,
                                       int req_w, int req_h, int fixed_dim,
                                       int crop_anchor,
                                       int *out_w, int *out_h)
{
    if (fixed_dim || (req_w <= 0 && req_h <= 0)) {
        *out_w = sw; *out_h = sh;
        return src; /* caller must not double-free; ownership kept by src */
    }

    if (req_w > 0 && req_h > 0) {
        /* "cover": scale to fully fill the box, crop the overflow from
         * the anchor point (center by default). */
        float scale = fmaxf((float)req_w / sw, (float)req_h / sh);
        int rw = (int)(sw * scale + 0.5f);
        int rh = (int)(sh * scale + 0.5f);
        if (rw < req_w) rw = req_w;
        if (rh < req_h) rh = req_h;

        unsigned char *resized = resize_bilinear(src, sw, sh, rw, rh);
        unsigned char *cropped = crop_anchored(resized, rw, rh, req_w, req_h, crop_anchor);
        free(resized);
        *out_w = req_w; *out_h = req_h;
        return cropped;
    }

    /* exactly one of req_w/req_h given -- follow source aspect ratio,
     * no cropping needed. */
    int dw, dh;
    if (req_w > 0) { dw = req_w; dh = (int)((float)sh * req_w / sw + 0.5f); }
    else           { dh = req_h; dw = (int)((float)sw * req_h / sh + 0.5f); }
    if (dw < 1) dw = 1;
    if (dh < 1) dh = 1;

    *out_w = dw; *out_h = dh;
    return resize_bilinear(src, sw, sh, dw, dh);
}

/* ------------------------------------------------------------------ */
/* quality search -- bisect on encoded size alone.                     */
/* ------------------------------------------------------------------ */
static unsigned char *search_quality(const unsigned char *rgb, int w, int h,
                                      size_t target_bytes, int min_q,
                                      SubsampleMode subsample, int progressive,
                                      unsigned long *out_len, int *out_q)
{
    unsigned char *best = NULL;
    unsigned long best_len = 0;
    int best_q = min_q;

    int lo = min_q, hi = 100;
    /* Seed with hi=100 first so we always have *some* result even if it
     * doesn't fit (matches libjpeg's own behaviour: quality is a request,
     * not a guarantee). */
    unsigned char *cand;
    unsigned long clen;

    cand = encode_jpeg_mem(rgb, w, h, hi, subsample, progressive, &clen);
    if (!cand) return NULL;
    if (clen <= target_bytes) {
        *out_len = clen; *out_q = hi;
        return cand;
    }
    free(cand);

    while (lo < hi) {
        int mid = (lo + hi + 1) / 2; /* bias up: prefer higher quality on ties */
        cand = encode_jpeg_mem(rgb, w, h, mid, subsample, progressive, &clen);
        if (!cand) break;

        if (clen <= target_bytes) {
            free(best);
            best = cand; best_len = clen; best_q = mid;
            lo = mid;
        } else {
            free(cand);
            hi = mid - 1;
        }
    }

    if (!best) {
        /* Nothing fit, even at min_q -- return the min_q encode anyway so
         * the caller always gets *a* result; they can decide to downscale
         * further (the fallback loop below does exactly that). */
        best = encode_jpeg_mem(rgb, w, h, min_q, subsample, progressive, &best_len);
        best_q = min_q;
    }

    *out_len = best_len;
    *out_q = best_q;
    return best;
}

/* ------------------------------------------------------------------ */
/* top-level: decode -> plan dims -> search quality -> (fallback       */
/* downscale loop if still over budget and dims weren't pinned).       */
/* ------------------------------------------------------------------ */
#define DEFAULT_MIN_QUALITY     20  /* below this, JPEG artifacts get ugly fast */
#define DEFAULT_MAX_SCALE_TRIES  5

typedef struct {
    unsigned char *data;
    unsigned long  len;
    int quality;
    int width, height;
    int met_target; /* 0 if we had to give up below min_quality */
} OptResult;

/* Every tunable knob lives here so the wasm entry point and the native
 * CLI's argv parser both build one of these and hand it to run_optimize --
 * new controls get added to this struct, not threaded as loose params. */
typedef struct {
    int req_w, req_h;
    int fixed_dim;
    int min_quality;      /* <= 0 means "use DEFAULT_MIN_QUALITY" */
    int max_scale_tries;  /* <= 0 means "use DEFAULT_MAX_SCALE_TRIES" */
    SubsampleMode subsample;
    int progressive;
    int crop_anchor;
} JpegoptParams;

static void jpegopt_params_init(JpegoptParams *p)
{
    memset(p, 0, sizeof(*p));
    p->subsample = SUBSAMPLE_444;
}

static int run_optimize(const unsigned char *in, size_t in_len,
                         size_t target_bytes, const JpegoptParams *params,
                         OptResult *res)
{
    int sw, sh;
    unsigned char *src = decode_jpeg_mem(in, in_len, &sw, &sh);
    if (!src) return -1;

    int min_quality = params->min_quality > 0 ? params->min_quality : DEFAULT_MIN_QUALITY;
    min_quality = clampi(min_quality, 1, 100);
    int max_scale_tries = params->max_scale_tries > 0 ? params->max_scale_tries : DEFAULT_MAX_SCALE_TRIES;

    int ow, oh;
    unsigned char *pixels = plan_dimensions(src, sw, sh, params->req_w, params->req_h,
                                             params->fixed_dim, params->crop_anchor,
                                             &ow, &oh);
    int pixels_is_src = (pixels == src);

    int can_autoscale = !params->fixed_dim && params->req_w <= 0 && params->req_h <= 0;
    int tries = can_autoscale ? max_scale_tries : 1;
    if (tries < 1) tries = 1;

    unsigned char *best_buf = NULL;
    unsigned long  best_len = 0;
    int best_q = min_quality, met = 0;
    int cur_w = ow, cur_h = oh;
    unsigned char *cur_pixels = pixels;
    int cur_owned = !pixels_is_src;

    for (int t = 0; t < tries; t++) {
        unsigned long enc_len;
        int q;
        unsigned char *enc = search_quality(cur_pixels, cur_w, cur_h,
                                             target_bytes, min_quality,
                                             params->subsample, params->progressive,
                                             &enc_len, &q);
        if (!enc) break;

        /* Always keep the latest attempt -- each retry (after a shrink)
         * is strictly closer to the target than the last, since we only
         * shrink when the previous attempt overshot the budget. */
        free(best_buf);
        best_buf = enc; best_len = enc_len; best_q = q;

        if (enc_len <= target_bytes) { met = 1; break; }
        if (t == tries - 1) break;

        /* Still too big even at min_quality -- shrink pixel count by the
         * ratio needed (area scales with bytes roughly linearly for a
         * fixed quality), then retry. */
        float ratio = sqrtf((float)target_bytes / (float)enc_len);
        if (ratio > 0.95f) ratio = 0.95f; /* guarantee forward progress */
        int nw = clampi((int)(cur_w * ratio), 16, cur_w - 1);
        int nh = clampi((int)(cur_h * ratio), 16, cur_h - 1);

        unsigned char *shrunk = resize_bilinear(cur_pixels, cur_w, cur_h, nw, nh);
        if (cur_owned) free(cur_pixels);
        cur_pixels = shrunk; cur_owned = 1;
        cur_w = nw; cur_h = nh;
    }

    if (cur_owned) free(cur_pixels);
    if (pixels_is_src) { /* src wasn't freed via cur_pixels path */ }
    free(src);

    if (!best_buf) return -1;

    res->data = best_buf;
    res->len = best_len;
    res->quality = best_q;
    res->width = cur_w;
    res->height = cur_h;
    res->met_target = met;
    return 0;
}

/* ================================================================== */
/* WASM-facing API                                                     */
/* ================================================================== */
static OptResult g_last; /* keeps the buffer alive until JS reads it   */

/*
 * Full-control entry point: every tunable in JpegoptParams is exposed as
 * its own argument so the JS side never has to pack/unpack a struct
 * through wasm memory for it. jpegopt_wasm_run (below) is a thin
 * backward-compatible wrapper over this with the original 6-argument
 * signature and every new knob left at its default.
 */
EMSCRIPTEN_KEEPALIVE
unsigned char *jpegopt_wasm_run_ex(const unsigned char *in, int in_len,
                                    int target_kb, int req_w, int req_h,
                                    int fixed_dim, int min_quality,
                                    int max_scale_tries, int subsample,
                                    int progressive, int crop_anchor)
{
    if (g_last.data) { free(g_last.data); g_last.data = NULL; }

    JpegoptParams params;
    jpegopt_params_init(&params);
    params.req_w = req_w;
    params.req_h = req_h;
    params.fixed_dim = fixed_dim;
    params.min_quality = min_quality;
    params.max_scale_tries = max_scale_tries;
    params.subsample = (SubsampleMode)clampi(subsample, 0, 3);
    params.progressive = progressive;
    params.crop_anchor = crop_anchor;

    if (run_optimize(in, (size_t)in_len, (size_t)target_kb * 1024, &params, &g_last) != 0) {
        return NULL;
    }
    return g_last.data;
}

EMSCRIPTEN_KEEPALIVE
unsigned char *jpegopt_wasm_run(const unsigned char *in, int in_len,
                                 int target_kb, int req_w, int req_h,
                                 int fixed_dim)
{
    return jpegopt_wasm_run_ex(in, in_len, target_kb, req_w, req_h, fixed_dim,
                                0 /* default min quality */,
                                0 /* default max scale tries */,
                                SUBSAMPLE_444, 0 /* baseline */, 0 /* center crop */);
}

EMSCRIPTEN_KEEPALIVE int jpegopt_wasm_last_len(void)      { return (int)g_last.len; }
EMSCRIPTEN_KEEPALIVE int jpegopt_wasm_last_quality(void)  { return g_last.quality; }
EMSCRIPTEN_KEEPALIVE int jpegopt_wasm_last_width(void)    { return g_last.width; }
EMSCRIPTEN_KEEPALIVE int jpegopt_wasm_last_height(void)   { return g_last.height; }
EMSCRIPTEN_KEEPALIVE int jpegopt_wasm_last_met_target(void) { return g_last.met_target; }

EMSCRIPTEN_KEEPALIVE void *jpegopt_wasm_alloc(int n) { return xmalloc((size_t)n); }
EMSCRIPTEN_KEEPALIVE void  jpegopt_wasm_free(void *p) { free(p); }

/* ================================================================== */
/* Native CLI                                                          */
/* ================================================================== */
#ifndef __EMSCRIPTEN__
static void usage(const char *argv0)
{
    fprintf(stderr,
        "usage: %s -i in.jpg -o out.jpg -t target_kb "
        "[--width W] [--height H] [--fixed-dimension]\n"
        "  [--min-quality Q] [--max-scale-tries N]\n"
        "  [--subsampling 444|422|420|411] [--progressive]\n"
        "  [--crop-anchor center|top|bottom|left|right]\n", argv0);
}

static int parse_subsampling(const char *s)
{
    if (!strcmp(s, "444")) return SUBSAMPLE_444;
    if (!strcmp(s, "422")) return SUBSAMPLE_422;
    if (!strcmp(s, "420")) return SUBSAMPLE_420;
    if (!strcmp(s, "411")) return SUBSAMPLE_411;
    return -1;
}

static int parse_crop_anchor(const char *s)
{
    if (!strcmp(s, "center")) return 0;
    if (!strcmp(s, "top")) return 1;
    if (!strcmp(s, "bottom")) return 2;
    if (!strcmp(s, "left")) return 3;
    if (!strcmp(s, "right")) return 4;
    return -1;
}

int main(int argc, char **argv)
{
    const char *in_path = NULL, *out_path = NULL;
    int target_kb = 0;
    JpegoptParams params;
    jpegopt_params_init(&params);

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-i") && i+1 < argc) in_path = argv[++i];
        else if (!strcmp(argv[i], "-o") && i+1 < argc) out_path = argv[++i];
        else if (!strcmp(argv[i], "-t") && i+1 < argc) target_kb = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--width") && i+1 < argc) params.req_w = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--height") && i+1 < argc) params.req_h = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--fixed-dimension")) params.fixed_dim = 1;
        else if (!strcmp(argv[i], "--min-quality") && i+1 < argc) params.min_quality = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--max-scale-tries") && i+1 < argc) params.max_scale_tries = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--progressive")) params.progressive = 1;
        else if (!strcmp(argv[i], "--subsampling") && i+1 < argc) {
            int m = parse_subsampling(argv[++i]);
            if (m < 0) { usage(argv[0]); return 1; }
            params.subsample = (SubsampleMode)m;
        }
        else if (!strcmp(argv[i], "--crop-anchor") && i+1 < argc) {
            int a = parse_crop_anchor(argv[++i]);
            if (a < 0) { usage(argv[0]); return 1; }
            params.crop_anchor = a;
        }
        else { usage(argv[0]); return 1; }
    }
    if (!in_path || !out_path || target_kb <= 0) { usage(argv[0]); return 1; }

    FILE *f = fopen(in_path, "rb");
    if (!f) { perror("fopen"); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *buf = xmalloc((size_t)sz);
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "error: short read on %s\n", in_path);
        fclose(f);
        return 1;
    }
    fclose(f);

    OptResult res;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    int rc = run_optimize(buf, (size_t)sz, (size_t)target_kb * 1024, &params, &res);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    free(buf);
    if (rc != 0) { fprintf(stderr, "optimize failed\n"); return 1; }

    FILE *out = fopen(out_path, "wb");
    if (!out) { perror("fopen"); return 1; }
    fwrite(res.data, 1, res.len, out);
    fclose(out);

    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    fprintf(stderr,
        "wrote %s: %ldx%ld px, q=%d, %lu bytes (target %d KB), %s, %.1f ms\n",
        out_path, (long)res.width, (long)res.height, res.quality, res.len,
        target_kb, res.met_target ? "met target" : "target too tight, used floor quality",
        ms);

    free(res.data);
    return 0;
}
#endif
