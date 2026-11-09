/* Independently implemented acoustic research worker. No DopplerGeist code.
 * Input units: seconds UTC, degrees, metres, Hz. Output scores are not
 * probabilities.
 */
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#endif
#define PI 3.14159265358979323846
#define MAX_EVENTS 8
#define MAX_POINTS 64
#define MAX_TRACKS 6000
#define MAX_ROWS 2000000
#define MAX_CELLS 80000
typedef struct {
  double t, x, y, z;
} Position;
typedef struct {
  char id[32];
  Position *p;
  size_t n, cache_offset;
  double min[3], max[3];
} Track;
typedef struct {
  int id, n;
  double t[MAX_POINTS], f[MAX_POINTS], w[MAX_POINTS];
} Event;
typedef struct {
  double lat, lon, height, x, y, z, clock;
} Cell;
static Track *tracks;
static size_t track_count;
static Event events[MAX_EVENTS];
static int event_count;
static Cell *cells;
static size_t cell_count;
static double start_time, end_time, time_step = 2, sound_speed = 343,
                                    max_gap = 30;
static atomic_size_t next_cell, completed;
static size_t position_count;
#ifndef DOPPLER_REFERENCE
// A receiver-specific, lazy memo: reuse exact vertex arrival times across
// clocks and ridge samples. Generation stamps avoid clearing all flight points
// per cell.
static _Thread_local double *arrival_values;
static _Thread_local uint32_t *arrival_stamps, arrival_generation;
#endif
static void fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(2);
}
static void *allocate(size_t n, size_t size) {
  void *p = calloc(n, size);
  if (!p)
    fail("Memory budget exceeded");
  return p;
}
static void ecef(double lat, double lon, double height, double *x, double *y,
                 double *z) {
  double a = lat * PI / 180, b = lon * PI / 180, s = sin(a),
         n = 6378137 / sqrt(1 - .00669437999014 * s * s);
  *x = (n + height) * cos(a) * cos(b);
  *y = (n + height) * cos(a) * sin(b);
  *z = (n * (1 - .00669437999014) + height) * s;
}
static int compare_position(const void *a, const void *b) {
  double d = ((const Position *)a)->t - ((const Position *)b)->t;
  return d < 0 ? -1 : d > 0;
}
static void load_tracks(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file)
    fail("Cannot open normalized tracks");
  tracks = allocate(MAX_TRACKS, sizeof(Track));
  char line[512], id[32];
  double t, lat, lon, h;
  size_t rows = 0, last = 0;
  while (fgets(line, sizeof line, file)) {
    char description[8] = {0};
    if (sscanf(line, "%31[^,],%lf,%lf,%lf,%lf,%7[^,\r\n]", id, &t, &lat, &lon,
               &h, description) < 5)
      continue;
    if (strlen(description) == 3 && description[2] == 'J')
      continue;
    if (!isfinite(t) || !isfinite(lat) || !isfinite(lon) || !isfinite(h) ||
        fabs(lat) > 90 || fabs(lon) > 180 || h < -500 || h > 30000)
      continue;
    if (strspn(id, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456"
                   "789_.-") != strlen(id))
      continue;
    size_t index = last;
    if (!track_count || strcmp(tracks[index].id, id))
      for (index = 0; index < track_count; index++)
        if (!strcmp(tracks[index].id, id))
          break;
    if (index == track_count) {
      if (track_count == MAX_TRACKS)
        fail("Too many aircraft; narrow the time or region");
      strcpy(tracks[index].id, id);
      track_count++;
    }
    last = index;
    Track *track = &tracks[index];
    if (++rows > MAX_ROWS)
      fail("Track point budget exceeded");
    if (!(track->n % 512)) {
      Position *p = realloc(track->p, (track->n + 512) * sizeof(Position));
      if (!p)
        fail("Track allocation failed");
      track->p = p;
    }
    Position *p = &track->p[track->n++];
    p->t = t;
    ecef(lat, lon, h, &p->x, &p->y, &p->z);
    double values[3] = {p->x, p->y, p->z};
    for (int axis = 0; axis < 3; axis++) {
      if (track->n == 1)
        track->min[axis] = track->max[axis] = values[axis];
      else {
        track->min[axis] = fmin(track->min[axis], values[axis]);
        track->max[axis] = fmax(track->max[axis], values[axis]);
      }
    }
  }
  fclose(file);
  for (size_t i = 0; i < track_count; i++) {
    qsort(tracks[i].p, tracks[i].n, sizeof(Position), compare_position);
    tracks[i].cache_offset = position_count;
    position_count += tracks[i].n;
  }
}
static void load_events(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file)
    fail("Cannot open observed ridges");
  char line[256];
  int id;
  double t, f, w;
  while (fgets(line, sizeof line, file)) {
    if (sscanf(line, "%d,%lf,%lf,%lf", &id, &t, &f, &w) != 4 || !isfinite(t) ||
        !isfinite(f) || !isfinite(w) || t < 0 || f < 15 || f > 900 || w <= 0)
      continue;
    int i;
    for (i = 0; i < event_count; i++)
      if (events[i].id == id)
        break;
    if (i == event_count) {
      if (event_count == MAX_EVENTS)
        fail("At most eight flyover events are supported");
      events[i].id = id;
      event_count++;
    }
    Event *event = &events[i];
    int n = event->n;
    if (n < MAX_POINTS) {
      event->t[n] = t;
      event->f[n] = f;
      event->w[n] = fmin(w, 10);
      event->n++;
    }
  }
  fclose(file);
  if (!event_count)
    fail("No usable observed frequency ridge");
  for (int i = 0; i < event_count; i++)
    if (events[i].n < 8)
      fail("Each event needs at least eight ridge points");
}
static void load_cells(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file)
    fail("Cannot open candidate grid");
  cells = allocate(MAX_CELLS, sizeof(Cell));
  char line[256];
  double lat, lon, height;
  while (fgets(line, sizeof line, file)) {
    if (sscanf(line, "%lf,%lf,%lf", &lat, &lon, &height) != 3 ||
        !isfinite(lat) || !isfinite(lon) || !isfinite(height) ||
        fabs(lat) > 90 || fabs(lon) > 180)
      continue;
    if (cell_count == MAX_CELLS)
      fail("Candidate grid budget exceeded");
    Cell *cell = &cells[cell_count++];
    cell->lat = lat;
    cell->lon = lon;
    cell->height = height;
    ecef(lat, lon, height, &cell->x, &cell->y, &cell->z);
  }
  fclose(file);
  if (!cell_count)
    fail("No candidate cells in selected countries or regions");
}
/* Linear ECEF interpolation, with a hard gap limit and no extrapolation. */
static int segment_geometry(const Track *track, const Cell *cell, double t,
                            size_t lo, size_t hi, double *distance,
                            double *radial) {
  Position a = track->p[lo], b = track->p[hi];
  double dt = b.t - a.t;
  if (dt <= 0 || dt > max_gap)
    return 0;
  double u = (t - a.t) / dt, dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  double rx = a.x + u * dx - cell->x, ry = a.y + u * dy - cell->y,
         rz = a.z + u * dz - cell->z;
  *distance = sqrt(rx * rx + ry * ry + rz * rz);
  if (*distance < 50)
    return 0;
  *radial = (dx * rx + dy * ry + dz * rz) / (dt * *distance);
  return fabs(*radial) < sound_speed * .85;
}
static int geometry(const Track *track, const Cell *cell, double t,
                    double *distance, double *radial) {
  if (track->n < 2 || t < track->p[0].t || t > track->p[track->n - 1].t)
    return 0;
  size_t lo = 0, hi = track->n - 1;
  while (hi - lo > 1) {
    size_t mid = (hi + lo) / 2;
    if (track->p[mid].t <= t)
      lo = mid;
    else
      hi = mid;
  }
  return segment_geometry(track, cell, t, lo, hi, distance, radial);
}
static double vertex_arrival(const Track *track, const Cell *cell,
                             size_t vertex) {
#ifndef DOPPLER_REFERENCE
  size_t key = track->cache_offset + vertex;
  if (arrival_values && arrival_stamps[key] == arrival_generation)
    return arrival_values[key];
#endif
  Position p = track->p[vertex];
  double value =
      p.t +
      hypot(hypot(p.x - cell->x, p.y - cell->y), p.z - cell->z) / sound_speed;
#ifndef DOPPLER_REFERENCE
  if (arrival_values) {
    arrival_values[key] = value;
    arrival_stamps[key] = arrival_generation;
  }
#endif
  return value;
}
static int doppler(const Track *track, const Cell *cell, double arrival,
                   double *factor, double *distance) {
  // Arrival times at track vertices are monotonic for subsonic trajectories.
  // Bracket in arrival space first: a fixed 15 s seed could leave a valid
  // segment.
  if (track->n < 2)
    return 0;
  size_t lo = 0, hi = track->n - 1;
  Position a = track->p[lo], b = track->p[hi];
  if (arrival < vertex_arrival(track, cell, lo) ||
      arrival > vertex_arrival(track, cell, hi))
    return 0;
  while (hi - lo > 1) {
    size_t mid = (hi + lo) / 2;
    if (vertex_arrival(track, cell, mid) <= arrival)
      lo = mid;
    else
      hi = mid;
  }
  a = track->p[lo];
  b = track->p[hi];
  if (b.t - a.t <= 0 || b.t - a.t > max_gap)
    return 0;
  double lower = a.t, upper = b.t, emission = (lower + upper) / 2, radial = 0,
         range = 0;
  for (int i = 0; i < 30; i++) {
#ifndef DOPPLER_REFERENCE
    // Newton stays within the arrival bracket. At a vertex retain the reference
    // binary search's right-segment convention, including gaps/duplicate times.
    if (emission >= a.t && emission < b.t) {
      if (!segment_geometry(track, cell, emission, lo, hi, &range, &radial))
        return 0;
    } else if (!geometry(track, cell, emission, &range, &radial))
      return 0;
#else
    if (!geometry(track, cell, emission, &range, &radial))
      return 0;
#endif
    double residual = emission + range / sound_speed - arrival;
    if (fabs(residual) < .000001) {
      *factor = sound_speed / (sound_speed + radial);
      *distance = range;
      return 1;
    }
    if (residual < 0)
      lower = emission;
    else
      upper = emission;
    double next = emission - residual / (1 + radial / sound_speed);
    emission = next > lower && next < upper ? next : (lower + upper) / 2;
  }
  return 0;
}
/* 2 kHz PCM is enough for the low-frequency aircraft ridge proposals. */
typedef struct {
  double re, im;
} Complex;
static void fft(Complex *a, int n) {
#ifdef __APPLE__
  static FFTSetupD setup;
  if (!setup)
    setup = vDSP_create_fftsetupD(13, kFFTRadix2);
  int logn = 0;
  for (int size = n; size > 1; size >>= 1)
    logn++;
  double re[8192], im[8192];
  for (int i = 0; i < n; i++) {
    re[i] = a[i].re;
    im[i] = a[i].im;
  }
  DSPDoubleSplitComplex split = {re, im};
  vDSP_fft_zipD(setup, &split, 1, logn, FFT_FORWARD);
  for (int i = 0; i < n; i++) {
    a[i].re = re[i];
    a[i].im = im[i];
  }
#else
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1)
      j ^= bit;
    j ^= bit;
    if (i < j) {
      Complex t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    double angle = -2 * PI / len, wr = cos(angle), wi = sin(angle);
    for (int i = 0; i < n; i += len) {
      double r = 1, im = 0;
      for (int j = 0; j < len / 2; j++) {
        Complex u = a[i + j], x = a[i + j + len / 2];
        double vr = x.re * r - x.im * im, vi = x.re * im + x.im * r;
        a[i + j] = (Complex){u.re + vr, u.im + vi};
        a[i + j + len / 2] = (Complex){u.re - vr, u.im - vi};
        double nr = r * wr - im * wi;
        im = r * wi + im * wr;
        r = nr;
      }
    }
  }
#endif
}
static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
         (uint32_t)p[3] << 24;
}
#include "method.c"
#include "discovery.c"
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("Dopplercrack C11 0.5 / automatic spectral workflow");
    return 0;
  }
  if (argc == 4 && !strcmp(argv[1], "spectrogram")) {
    make_spectrogram(argv[2], argv[3]);
    return 0;
  }
  if (argc == 5 && !strcmp(argv[1], "measure")) {
    measure_events(argv[2], strtod(argv[3], NULL), argv[4]);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "locate")) {
    locate(argc, argv);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "serve")) {
    serve(argc, argv);
    return 0;
  }
  if (argc == 4 && !strcmp(argv[1], "discover")) {
    discover_spectrum(argv[2], argv[3]);
    return 0;
  }
  if (argc == 4 && !strcmp(argv[1], "analyze")) {
    analyze(argv[2], argv[3]);
    return 0;
  }
  fail("Usage: dopplercrack analyze AUDIO.wav OUTPUT.json | spectrogram "
       "AUDIO.wav OUTPUT.bin | measure RIDGES.csv SOUND_SPEED OUTPUT.json | "
       "locate ...");
  return 2;
}
