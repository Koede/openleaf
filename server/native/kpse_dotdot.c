/*
 * kpse_dotdot.c: let TeX read "a/b/../c.tex" when the path stays inside the project.
 *
 * openleaf runs TeX with openin_any=p ("paranoid"), which rejects every path that
 * contains a ".." component, even "chapters/03/../04/x.tex", which never leaves the
 * project. Documents written for Overleaf use such paths a lot (\subimport{../x/}{y}).
 *
 * This library is loaded with LD_PRELOAD into latexmk and the TeX engines. It wraps
 * kpathsea's kpse_in_name_ok(): if the real check accepts the name, so do we. If it
 * rejects it, we accept it only when all of these hold:
 *   - the name is relative (no leading '/'),
 *   - no component is a hidden file or directory (".git", ".ssh", ...),
 *   - walking the components lexically, ".." never climbs above the starting
 *     directory (the project's build directory, which holds plain copies of the
 *     project files: no symbolic links, so lexical and real resolution agree).
 * Everything else paranoid mode forbids (absolute paths, "../" out of the project,
 * dot-files) stays forbidden. Writing (kpse_out_name_ok) is not touched.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>

typedef int boolean;
typedef boolean (*name_ok_fn)(const char *);

static int stays_inside(const char *name) {
  if (!name || !*name || name[0] == '/') return 0;
  int depth = 0;
  const char *p = name;
  for (;;) {
    const char *slash = strchr(p, '/');
    size_t n = slash ? (size_t)(slash - p) : strlen(p);
    if (n == 2 && p[0] == '.' && p[1] == '.') {
      if (--depth < 0) return 0;          /* climbs out of the project */
    } else if (n == 0 || (n == 1 && p[0] == '.')) {
      /* "//" or "./": no change */
    } else if (p[0] == '.') {
      return 0;                           /* hidden file or directory */
    } else {
      depth++;
    }
    if (!slash) break;
    p = slash + 1;
  }
  return 1;
}

boolean kpse_in_name_ok(const char *fname) {
  static name_ok_fn real = 0;
  if (!real) real = (name_ok_fn)dlsym(RTLD_NEXT, "kpse_in_name_ok");
  if (real && real(fname)) return 1;
  return strstr(fname ? fname : "", "..") != 0 && stays_inside(fname);
}
