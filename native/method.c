/* Independent reconstruction of the published method; included by worker.c.
 * Video-specific measured bounds are inputs, never constants for other
 * recordings.
 */
typedef struct {
  uint32_t nt, nf;
  double t0, dt, f0, df, duration, scale;
  unsigned char *values;
} Spectrogram;
typedef struct {
  double cpa, tolerance, vmin, vmax, rmin, rmax, fmin, fmax;
} Measurement;
typedef struct {
  int track;
  double emission, arrival, range, speed;
} Approach;
typedef struct {
  int track;
  double rest, rmse, score;
  Approach cpa;
} EventFit;
typedef struct {
  Cell cell;
  double rank, score, rmse;
  int association_order;
  double trial_order;
  EventFit fits[MAX_EVENTS];
} MethodResult;
static Measurement measurements[MAX_EVENTS];
static char allowed_flights[MAX_EVENTS][32];
static Spectrogram observed_spectrum;
static MethodResult *method_results;
static int filter_only, spectral_mode, silence_enabled;
static atomic_ullong physics_survivors, silence_rejections, scored_pairs;
typedef struct {
  MethodResult result;
  int next;
} FlightLeader;
typedef struct {
  FlightLeader *entries;
  int count, capacity;
  int buckets[16384];
} FlightLeaders;
static FlightLeaders thread_leaders[32];
static void retain_flight_leader(FlightLeaders *leaders,
                                 const MethodResult *result) {
  uint32_t hash = 2166136261U;
  for (int e = 0; e < event_count; e++) {
    hash ^= (uint32_t)result->fits[e].track;
    hash *= 16777619U;
  }
  int bucket = hash % 16384;
  for (int n = leaders->buckets[bucket]; n; n = leaders->entries[n - 1].next) {
    MethodResult *prior = &leaders->entries[n - 1].result;
    int same = 1;
    for (int e = 0; e < event_count; e++)
      if (prior->fits[e].track != result->fits[e].track)
        same = 0;
    if (same) {
      if (result->rank < prior->rank ||
          (result->rank == prior->rank &&
           (result->cell.lat < prior->cell.lat ||
            (result->cell.lat == prior->cell.lat &&
             (result->cell.lon < prior->cell.lon ||
              (result->cell.lon == prior->cell.lon &&
               (result->association_order < prior->association_order ||
                (result->association_order == prior->association_order &&
                 result->trial_order < prior->trial_order))))))))
        *prior = *result;
      return;
    }
  }
  if (leaders->count == 100000)
    fail("Flight-combination budget exceeded; narrow event measurements or "
         "geography");
  if (leaders->count == leaders->capacity) {
    int capacity = leaders->capacity ? leaders->capacity * 2 : 128;
    FlightLeader *p =
        realloc(leaders->entries, (size_t)capacity * sizeof(FlightLeader));
    if (!p)
      fail("Flight leader allocation failed");
    leaders->entries = p;
    leaders->capacity = capacity;
  }
  int n = leaders->count++;
  leaders->entries[n] = (FlightLeader){*result, leaders->buckets[bucket]};
  leaders->buckets[bucket] = n + 1;
}
static int double_compare(const void *a, const void *b) {
  double d = *(const double *)a - *(const double *)b;
  return d < 0 ? -1 : d > 0;
}
static void make_spectrogram(const char *path, const char *output) {
  FILE *file = fopen(path, "rb");
  if (!file)
    fail("Cannot read acoustic WAV");
  unsigned char h[12], chunk[8], fmt[40];
  int rate = 0, bits = 0, channels = 0;
  uint32_t bytes = 0;
  if (fread(h, 1, 12, file) != 12 || memcmp(h, "RIFF", 4) ||
      memcmp(h + 8, "WAVE", 4))
    fail("Expected RIFF PCM WAV");
  while (fread(chunk, 1, 8, file) == 8) {
    uint32_t size = le32(chunk + 4);
    if (!memcmp(chunk, "fmt ", 4)) {
      if (size < 16 || size > 40 || fread(fmt, 1, size, file) != size ||
          fmt[0] != 1)
        fail("Expected PCM WAV");
      channels = fmt[2];
      rate = (int)le32(fmt + 4);
      bits = fmt[14];
    } else if (!memcmp(chunk, "data", 4)) {
      bytes = size;
      break;
    } else if (fseek(file, size, SEEK_CUR))
      fail("Malformed WAV");
    if (size & 1)
      fseek(file, 1, SEEK_CUR);
  }
  if (rate != 2048 || bits != 16 || channels != 1 || !bytes ||
      bytes > 2048 * 2 * 1800)
    fail("Spectrogram requires mono 2048 Hz PCM, <=30 minutes");
  size_t count = bytes / 2;
  int16_t *pcm = allocate(count, sizeof(int16_t));
  if (fread(pcm, 2, count, file) != count)
    fail("Truncated WAV");
  fclose(file);
  Spectrogram s = {.nt = (uint32_t)((count + 1023) / 1024 + 1),
                   .nf = 3541,
                   .t0 = 0,
                   .dt = .5,
                   .f0 = 15,
                   .df = .25,
                   .duration = count / 2048.0, .scale = 1};
  float *power = allocate((size_t)s.nt * s.nf, sizeof(float));
  Complex *bins = allocate(8192, sizeof(Complex));
  // Short clips need enough independent windows to resolve motion. Keep the
  // frequency lattice fixed with zero padding; do not pretend padding improves
  // true resolution. Longer recordings retain the original four-second Hann.
  int window_length = count < 2048*16 ? 2048 : count < 2048*32 ? 4096 : 8192;
  double window[8192];
  for (int j = 0; j < 8192; j++)
    window[j] = j<window_length ? .5-.5*cos(2*PI*j/(window_length-1)) : 0;
  for (uint32_t t = 0; t < s.nt; t++) {
    for (int j = 0; j < 8192; j++) {
      long k = (long)t * 1024 + j - window_length/2;
      bins[j] =
          (Complex){k >= 0 && (size_t)k < count ? pcm[k] * window[j] : 0, 0};
    }
    fft(bins, 8192);
    for (uint32_t f = 0; f < s.nf; f++) {
      uint32_t k = f + 60;
      power[(size_t)t * s.nf + f] =
          (float)(10 *
                  log10(1 + bins[k].re * bins[k].re + bins[k].im * bins[k].im));
    }
  }
  free(pcm);
  free(bins);
  s.values = allocate((size_t)s.nt * s.nf, 1);
  double *column = allocate(s.nt, sizeof(double));
  // Explicit reproduction choice: subtract each frequency's temporal median.
  // This is a display/scoring contrast, not a claimed original-video parameter.
  for (uint32_t f = 0; f < s.nf; f++) {
    for (uint32_t t = 0; t < s.nt; t++)
      column[t] = power[(size_t)t * s.nf + f];
    qsort(column, s.nt, sizeof(double), double_compare);
    double floor = column[s.nt / 2];
    for (uint32_t t = 0; t < s.nt; t++) {
      // 0.25 dB/byte saturated strong tones into broad flat plateaus. Preserve
      // the full PCM dynamic range so discovery can locate the actual peak.
      double db = fmax(0, fmin(255, power[(size_t)t * s.nf + f] - floor));
      s.values[(size_t)t * s.nf + f] = (unsigned char)lround(db);
    }
  }
  free(power);
  free(column);
  FILE *out = fopen(output, "wb");
  if (!out)
    fail("Cannot write spectrogram");
  unsigned char header[64] = {0};
  memcpy(header, "SGSPEC3", 7);
  memcpy(header + 8, &s.nt, 4);
  memcpy(header + 12, &s.nf, 4);
  memcpy(header + 16, &s.t0, 8);
  memcpy(header + 24, &s.dt, 8);
  memcpy(header + 32, &s.f0, 8);
  memcpy(header + 40, &s.df, 8);
  memcpy(header + 48, &s.duration, 8);
  memcpy(header + 56, &s.scale, 8);
  if (fwrite(header, 1, 64, out) != 64 ||
      fwrite(s.values, 1, (size_t)s.nt * s.nf, out) != (size_t)s.nt * s.nf)
    fail("Cannot write spectral data");
  fclose(out);
  free(s.values);
}
static void load_spectrogram(const char *path) {
  FILE *f = fopen(path, "rb");
  unsigned char h[64];
  if (!f || fread(h, 1, 64, f) != 64 || (memcmp(h, "SGSPEC2", 7)&&memcmp(h,"SGSPEC3",7)))
    fail("Reanalyze this recording to prepare its spectrogram");
  Spectrogram *s = &observed_spectrum;
  memcpy(&s->nt, h + 8, 4);
  memcpy(&s->nf, h + 12, 4);
  memcpy(&s->t0, h + 16, 8);
  memcpy(&s->dt, h + 24, 8);
  memcpy(&s->f0, h + 32, 8);
  memcpy(&s->df, h + 40, 8);
  memcpy(&s->duration, h + 48, 8);
  s->scale=4;if(!memcmp(h,"SGSPEC3",7))memcpy(&s->scale,h+56,8);
  if (!s->nt || s->nt > 3602 || s->nf != 3541 || s->dt != .5 || s->df != .25 || !isfinite(s->scale) || s->scale<=0 ||
      s->f0 != 15 || s->t0 != 0 || !isfinite(s->duration) || s->duration<=0 || s->duration>1800 || s->nt!=(uint32_t)(ceil(s->duration*2)+1))
    fail("Invalid spectral data");
  size_t n = (size_t)s->nt * s->nf;
  s->values = allocate(n, 1);
  if (fread(s->values, 1, n, f) != n)
    fail("Truncated spectral data");
  fclose(f);
}
static double brightness(double t, double hz) {
  Spectrogram *s = &observed_spectrum;
  double x = (t - s->t0) / s->dt, y = (hz - s->f0) / s->df;
  if (x < 0 || y < 0 || x > s->nt - 1 || y > s->nf - 1)
    return NAN;
  uint32_t a = (uint32_t)x, b = (uint32_t)y, c = a + 1 < s->nt ? a + 1 : a,
           d = b + 1 < s->nf ? b + 1 : b;
  double u = x - a, v = y - b;
  return ((1 - u) * ((1 - v) * s->values[(size_t)a * s->nf + b] +
                     v * s->values[(size_t)a * s->nf + d]) +
          u * ((1 - v) * s->values[(size_t)c * s->nf + b] +
               v * s->values[(size_t)c * s->nf + d])) /
         s->scale;
}
static double ideal_factor(double t, double cpa, double velocity, double slant,
                           double c) {
  double beta = velocity / c, s = t - cpa + slant / c;
  double tau = (s - sqrt(beta * beta * s * s +
                         (1 - beta * beta) * slant * slant / (c * c))) /
               (1 - beta * beta);
  double r = hypot(slant, velocity * tau),
         radial = velocity * velocity * tau / r;
  return c / (c + radial);
}
static double ideal_loss(const Event *e, double cpa, double v, double r,
                         double c, double *rest) {
  double a = 0, b = 0, w = 0, error = 0;
  for (int i = 0; i < e->n; i++) {
    double k = ideal_factor(e->t[i], cpa, v, r, c);
    a += e->w[i] * k * e->f[i];
    b += e->w[i] * k * k;
    w += e->w[i];
  }
  *rest = a / b;
  for (int i = 0; i < e->n; i++) {
    double d = e->f[i] - *rest * ideal_factor(e->t[i], cpa, v, r, c);
    error += e->w[i] * d * d;
  }
  return sqrt(error / w);
}
static void measure_events(const char *ridges, double c, const char *output) {
  if (!isfinite(c) || c < 290 || c > 370)
    fail("Invalid sound speed");
  load_events(ridges);
  FILE *out = fopen(output, "w");
  if (!out)
    fail("Cannot write measurements");
  fputs("{\"events\":[", out);
  for (int e = 0; e < event_count; e++) {
    Event *event = &events[e];
    double best = 1e9, bc = 0, bv = 0, br = 0, bf = 0, start = event->t[0],
           end = event->t[event->n - 1];
    for (double v = 30; v <= 230; v += 20)
      for (double r = 200; r <= 10000; r *= 1.65)
        for (int j = -2; j <= 10; j++) {
          double cpa = start + (end - start) * j / 8, rest;
          double loss = ideal_loss(event, cpa, v, r, c, &rest);
          if (loss < best) {
            best = loss;
            bc = cpa;
            bv = v;
            br = r;
            bf = rest;
          }
        }
    double dc = (end - start) / 4, dv = 30, dr = br * .5;
    for (int round = 0; round < 12; round++) {
      for (int axis = 0; axis < 3; axis++)
        for (int direction = -1; direction <= 1; direction += 2) {
          double cp = bc + (axis == 0 ? direction * dc : 0),
                 v = bv + (axis == 1 ? direction * dv : 0),
                 r = br + (axis == 2 ? direction * dr : 0), rest;
          if (v < 15 || v > 250 || r < 100 || r > 10000 || cp < start - 300 ||
              cp > end + 300)
            continue;
          double loss = ideal_loss(event, cp, v, r, c, &rest);
          if (loss < best) {
            best = loss;
            bc = cp;
            bv = v;
            br = r;
            bf = rest;
          }
        }
      dc *= .6;
      dv *= .6;
      dr *= .6;
    }
    fprintf(
        out,
        "%s{\"id\":%d,\"approximation\":{\"cpaSeconds\":%.4f,\"speedMps\":%.3f,"
        "\"slantM\":%.2f,\"restHz\":%.4f,\"rmseHz\":%.4f},\"reviewed\":false}",
        e ? "," : "", event->id, bc, bv, br, bf, best);
  }
  fputs("]}", out);
  fclose(out);
}
static void load_measurements(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file)
    fail("Missing reviewed event measurements");
  char line[512];
  int id, seen[MAX_EVENTS] = {0};
  while (fgets(line, sizeof line, file)) {
    Measurement m;
    char allowed[32] = {0};
    if (sscanf(line, "%d,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%31[A-Za-z0-9_.-]",
               &id, &m.cpa, &m.tolerance, &m.vmin, &m.vmax, &m.rmin, &m.rmax,
               &m.fmin, &m.fmax, allowed) < 9)
      continue;
    int i;
    for (i = 0; i < event_count; i++)
      if (events[i].id == id)
        break;
    if (i == event_count)
      continue;
    double values[] = {m.cpa,  m.tolerance, m.vmin, m.vmax,
                       m.rmin, m.rmax,      m.fmin, m.fmax};
    for (int k = 0; k < 8; k++)
      if (!isfinite(values[k]))
        fail("Non-finite event measurement");
    if (m.tolerance < 0 || m.tolerance > 240 || m.vmin < 10 ||
        m.vmax >= sound_speed * .85 || m.vmax < m.vmin || m.rmin < 50 ||
        m.rmax > 10000 || m.rmax < m.rmin || m.fmin < 15 || m.fmax > 900 ||
        m.fmax < m.fmin || m.fmax - m.fmin > 885)
      fail("Invalid event bounds");
    measurements[i] = m;
    strcpy(allowed_flights[i], allowed);
    seen[i] = 1;
  }
  fclose(file);
  for (int e = 0; e < event_count; e++)
    if (!seen[e])
      fail("Each selected event requires reviewed speed, slant, CPA and tone "
           "bounds");
}
#define MAX_APPROACHES 2048
#define MAX_MATCHES 256
typedef struct {
  Approach p[MAX_MATCHES];
  int n;
} Matches;
#ifndef DOPPLER_REFERENCE
typedef struct {
  double min[3], max[3];
  size_t first, end, next;
  int leaf;
} SegmentNode;
typedef struct {
  SegmentNode *nodes;
  size_t count;
} SegmentTree;
static SegmentTree segment_trees[MAX_TRACKS];
static size_t build_segment_node(SegmentTree *tree, const Track *track,
                                 size_t first, size_t end) {
  size_t index = tree->count++;
  SegmentNode *node = &tree->nodes[index];
  node->first = first;
  node->end = end;
  node->leaf = end - first <= 8;
  if (node->leaf) {
    for (size_t j = first; j <= end; j++) {
      double p[3] = {track->p[j].x, track->p[j].y, track->p[j].z};
      for (int k = 0; k < 3; k++) {
        if (j == first)
          node->min[k] = node->max[k] = p[k];
        else {
          node->min[k] = fmin(node->min[k], p[k]);
          node->max[k] = fmax(node->max[k], p[k]);
        }
      }
    }
  } else {
    size_t middle = first + (end - first) / 2,
           left = build_segment_node(tree, track, first, middle),
           right = build_segment_node(tree, track, middle, end);
    for (int k = 0; k < 3; k++) {
      node->min[k] = fmin(tree->nodes[left].min[k], tree->nodes[right].min[k]);
      node->max[k] = fmax(tree->nodes[left].max[k], tree->nodes[right].max[k]);
    }
  }
  node->next = tree->count;
  return index;
}
static void build_segment_trees(void) {
  for (size_t f = 0; f < track_count; f++)
    if (tracks[f].n > 1) {
      segment_trees[f].nodes = allocate(tracks[f].n * 2, sizeof(SegmentNode));
      build_segment_node(&segment_trees[f], &tracks[f], 0, tracks[f].n - 1);
    }
}
static int node_may_approach(const SegmentNode *node, const Track *track,
                             const Cell *cell) {
  // Linear interpolation stays inside the endpoint AABB. A tiny outward guard
  // prevents rounding at 10.2 km from deleting a reference survivor.
  double p[3] = {cell->x, cell->y, cell->z}, lower = 0;
  for (int k = 0; k < 3; k++) {
    double d = fmax(node->min[k] - p[k], fmax(0, p[k] - node->max[k]));
    lower += d * d;
  }
  if (lower > (10200.0 + 1e-5) * (10200.0 + 1e-5))
    return 0;
  return !(
      track->p[node->end].t + 10200.0 / sound_speed < start_time - 360 - 1e-5 ||
      track->p[node->first].t >
          end_time + events[event_count - 1].t[events[event_count - 1].n - 1] +
              360 + 1e-5);
}
#endif
static int approaches_for_cell(const Cell *cell, Approach *out) {
  int count = 0;
  for (size_t f = 0; f < track_count; f++) {
    Track *track = &tracks[f];
    double rr[3] = {cell->x, cell->y, cell->z}, lower = 0;
    for (int axis = 0; axis < 3; axis++) {
      double d = fmax(track->min[axis] - rr[axis],
                      fmax(0, rr[axis] - track->max[axis]));
      lower += d * d;
    }
    if (lower > 10200.0 * 10200)
      continue;
#ifndef DOPPLER_REFERENCE
    SegmentTree *tree = &segment_trees[f];
    for (size_t node_index = 0; node_index < tree->count;) {
      SegmentNode *node = &tree->nodes[node_index];
      if (!node_may_approach(node, track, cell)) {
        node_index = node->next;
        continue;
      }
      node_index++;
      if (!node->leaf)
        continue;
      for (size_t j = node->first; j < node->end; j++) {
#else
    for (size_t j = 0; j + 1 < track->n; j++) {
#endif
        Position a = track->p[j], b = track->p[j + 1];
        double dt = b.t - a.t;
        if (dt <= 0 || dt > max_gap)
          continue;
        double dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z,
               v2 = (dx * dx + dy * dy + dz * dz) / (dt * dt);
        if (v2 < 100 || v2 >= sound_speed * sound_speed * .85 * .85)
          continue;
        double rx = a.x - cell->x, ry = a.y - cell->y, rz = a.z - cell->z,
               u = -(rx * dx + ry * dy + rz * dz) / (v2 * dt * dt);
        if (u >= 1)
          continue;
        if (u <= 0) {
          if (!j)
            continue;
          Position before = track->p[j - 1];
          double gap = a.t - before.t;
          if (gap <= 0 || gap > max_gap)
            continue;
          double dot = (a.x - before.x) * rx + (a.y - before.y) * ry +
                       (a.z - before.z) * rz;
          if (dot > 0)
            continue;
          u = 0;
        }
        double range = hypot(hypot(rx + u * dx, ry + u * dy), rz + u * dz);
        if (range > 10200 || range < 50)
          continue;
        double emission = a.t + u * dt,
               arrival = emission + range / sound_speed;
        if (arrival < start_time - 360 ||
            arrival >
                end_time +
                    events[event_count - 1].t[events[event_count - 1].n - 1] +
                    360)
          continue;
        if (count == MAX_APPROACHES)
          fail("Too many local approaches; narrow the time window");
        out[count++] = (Approach){(int)f, emission, arrival, range, sqrt(v2)};
      }
#ifndef DOPPLER_REFERENCE
    }
#endif
  }
  return count;
}
static int evaluate_event(const Event *event, const Measurement *m,
                          const Cell *cell, const Approach *cpa, double clock,
                          EventFit *fit, double cutoff) {
  double a = 0, b = 0, w = 0, k[MAX_POINTS], range;
  unsigned char known[MAX_POINTS] = {0};
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
  if (!spectral_mode && cutoff < 1e29) {
    // Projection onto one shared-frequency ray. A prefix's minimized squared
    // error is a lower bound on the full error, divided by the FULL weight.
    // Test separated samples first, then fill gaps; final sums retain input
    // order.
    int order[MAX_POINTS], count = 0, used[MAX_POINTS] = {0};
    order[count++] = 0;
    used[0] = 1;
    order[count++] = event->n - 1;
    used[event->n - 1] = 1;
    for (int denominator = 2; count < event->n; denominator *= 2)
      for (int j = 1; j < denominator && count < event->n; j += 2) {
        int i = (event->n - 1) * j / denominator;
        if (!used[i]) {
          used[i] = 1;
          order[count++] = i;
        }
      }
    double total_w = 0, energy = 0, pa = 0, pb = 0;
    for (int i = 0; i < event->n; i++) {
      total_w += event->w[i];
      energy += event->w[i] * event->f[i] * event->f[i];
    }
    for (int q = 0; q < event->n; q++) {
      int i = order[q];
      if (!doppler(&tracks[cpa->track], cell, clock + event->t[i], &k[i],
                   &range))
        return 0;
      known[i] = 1;
      pa += event->w[i] * k[i] * event->f[i];
      pb += event->w[i] * k[i] * k[i];
      if (q == 1 || q == 3 || q == 7 || q == 15 || q == 31) {
        double f = fmax(m->fmin, fmin(m->fmax, pa / pb)), error = 0;
        for (int p = 0; p <= q; p++) {
          int j = order[p];
          double r = event->f[j] - f * k[j];
          error += event->w[j] * r * r;
        }
        if ((error - 1e-10 * (1 + energy)) / total_w >
            cutoff + 1e-10 * (1 + fabs(cutoff)))
          return 0;
      }
    }
  }
#else
  (void)cutoff;
#endif
  for (int i = 0; i < event->n; i++) {
    if (!known[i] &&
        !doppler(&tracks[cpa->track], cell, clock + event->t[i], &k[i], &range))
      return 0;
    a += event->w[i] * k[i] * event->f[i];
    b += event->w[i] * k[i] * k[i];
    w += event->w[i];
  }
  double rest = fmax(m->fmin, fmin(m->fmax, a / b)), score = 0;
  if (spectral_mode) {
    double factors[3602], times[3602];
    int n = 0;
    double from = ceil(event->t[0] * 2) / 2, to = event->t[event->n - 1];
    for (double t = from; t <= to + .00001; t += .5) {
      if (n == 3602 ||
          !doppler(&tracks[cpa->track], cell, clock + t, &factors[n], &range))
        return 0;
      times[n++] = t;
    }
    if (n < 8)
      return 0;
    double best = -1, bestf = 0;
    int steps = (int)ceil((m->fmax - m->fmin) / .125);
    if (steps < 1)
      steps = 1;
#ifndef DOPPLER_REFERENCE
    // Transpose the sweep for row locality. Each frequency still accumulates
    // the same frames in the same order, with the same frequency arithmetic.
    double frequencies[7082], sums[7082] = {0};
    int valid_frequency[7082];
    for (int j = 0; j <= steps; j++) {
      frequencies[j] = m->fmin + (m->fmax - m->fmin) * j / steps;
      valid_frequency[j] = 1;
    }
    for (int i = 0; i < n; i++) {
      double x = (times[i] - observed_spectrum.t0) / observed_spectrum.dt;
      int row = (int)x, aligned = x == row && row >= 0 &&
                                  (uint32_t)row < observed_spectrum.nt;
      const unsigned char *pixels =
          aligned
              ? observed_spectrum.values + (size_t)row * observed_spectrum.nf
              : NULL;
      for (int j = 0; j <= steps; j++)
        if (valid_frequency[j]) {
          double hz = frequencies[j] * factors[i], value;
          if (aligned) {
            double y = (hz - observed_spectrum.f0) / observed_spectrum.df;
            if (y < 0 || y > observed_spectrum.nf - 1) {
              valid_frequency[j] = 0;
              continue;
            }
            uint32_t b = (uint32_t)y,
                     d = b + 1 < observed_spectrum.nf ? b + 1 : b;
            double v = y - b;
            value = ((1 - v) * pixels[b] + v * pixels[d]) / observed_spectrum.scale;
          } else
            value = brightness(times[i], hz);
          if (!isfinite(value)) {
            valid_frequency[j] = 0;
            continue;
          }
          sums[j] += value;
        }
    }
    for (int j = 0; j <= steps; j++)
      if (valid_frequency[j] && sums[j] / n > best) {
        best = sums[j] / n;
        bestf = frequencies[j];
      }
#else
    for (int j = 0; j <= steps; j++) {
      double frequency = m->fmin + (m->fmax - m->fmin) * j / steps, sum = 0;
      int valid = 1;
      for (int i = 0; i < n; i++) {
        double value = brightness(times[i], frequency * factors[i]);
        if (!isfinite(value)) {
          valid = 0;
          break;
        }
        sum += value;
      }
      if (valid && sum / n > best) {
        best = sum / n;
        bestf = frequency;
      }
    }
#endif
    if (best < 0)
      return 0;
    rest = bestf;
    score = best * n;
  }
  double error = 0;
  for (int i = 0; i < event->n; i++) {
    double d = event->f[i] - rest * k[i];
    error += event->w[i] * d * d;
  }
  double rms = sqrt(error / w);
  if (!spectral_mode)
    score = -rms * rms;
  *fit = (EventFit){cpa->track, rest, rms, score, *cpa};
  return 1;
}
typedef struct {
  EventFit fit[MAX_EVENTS][MAX_MATCHES], chosen[MAX_EVENTS], best[MAX_EVENTS];
  int n[MAX_EVENTS];
  double best_score;
  const Approach *all;
  int nall;
  FlightLeaders *leaders;
  const Cell *cell;
  double clock;
  unsigned int combinations;
} Assignment;
static int violates_silence(const Assignment *a) {
  if (!silence_enabled || event_count < 2)
    return 0;
  double from = 1e30, to = -1e30, radius = 0;
  for (int e = 0; e < event_count; e++) {
    from = fmin(from, a->chosen[e].cpa.arrival);
    to = fmax(to, a->chosen[e].cpa.arrival);
    radius = fmax(radius, a->chosen[e].cpa.range);
  }
  for (int j = 0; j < a->nall; j++) {
    const Approach *p = &a->all[j];
    if (p->arrival <= from || p->arrival >= to ||
        p->range + (filter_only ? 284 : 0) >= radius)
      continue;
    int used = 0;
    for (int e = 0; e < event_count; e++)
      if (a->chosen[e].track == p->track)
        used = 1;
    if (!used)
      return 1;
  }
  return 0;
}
static void assign_events(Assignment *a, int event, double total) {
  if (filter_only && a->best_score > -1e29)
    return;
  if (++a->combinations > 1000000)
    fail(
        "Too many candidate event combinations; narrow the measurement ranges");
  if (event >= event_count) {
    if (violates_silence(a)) {
      atomic_fetch_add(&silence_rejections, 1);
      return;
    }
    if (total > a->best_score) {
      a->best_score = total;
      memcpy(a->best, a->chosen, sizeof a->best);
    }
    if (!filter_only) {
      MethodResult r = {.cell = *a->cell, .rank = -total, .score = total};
      r.cell.clock = a->clock;
      memcpy(r.fits, a->chosen, sizeof r.fits);
      double sum = 0;
      for (int e = 0; e < event_count; e++)
        sum += pow(r.fits[e].rmse / r.fits[e].rest, 2);
      r.rmse = sqrt(sum / event_count);
      retain_flight_leader(a->leaders, &r);
    }
    return;
  }
  if (event < 0 || event >= MAX_EVENTS)
    return;
  for (int j = 0; j < a->n[event]; j++) {
    EventFit *fit = &a->fit[event][j];
    int used = 0;
    for (int e = 0; e < event; e++)
      if (a->chosen[e].track == fit->track)
        used = 1;
    if (used)
      continue;
    a->chosen[event] = *fit;
    assign_events(a, event + 1, total + fit->score);
  }
}
#include "bounds.c"
static void *method_thread(void *context) {
  FlightLeaders *leaders = context;
  Approach *all = allocate(MAX_APPROACHES, sizeof(Approach));
  Matches *matches = allocate(MAX_EVENTS, sizeof(Matches));
  Assignment *assignment = allocate(1, sizeof(Assignment));
#ifndef DOPPLER_REFERENCE
  arrival_values =
      allocate(position_count ? position_count : 1, sizeof(double));
  arrival_stamps =
      allocate(position_count ? position_count : 1, sizeof(uint32_t));
  arrival_generation = 0;
#endif
  for (;;) {
    size_t index = atomic_fetch_add(&next_cell, 1);
    if (index >= cell_count)
      break;
    Cell *cell = &cells[index];
#ifndef DOPPLER_REFERENCE
    if (++arrival_generation == 0) {
      memset(arrival_stamps, 0, position_count * sizeof(uint32_t));
      arrival_generation = 1;
    }
#endif
    MethodResult *result = &method_results[index];
    result->cell = *cell;
    result->rank = 1e30;
    int nall = approaches_for_cell(cell, all);
    memset(matches, 0, MAX_EVENTS * sizeof(Matches));
    for (int e = 0; e < event_count; e++) {
      Measurement *m = &measurements[e];
      double padding = filter_only ? 142 : 0;
      for (int j = 0; j < nall; j++) {
        Approach *p = &all[j];
        if (allowed_flights[e][0] &&
            strcmp(allowed_flights[e], tracks[p->track].id))
          continue;
        double implied = p->arrival - m->cpa;
        if (p->speed < m->vmin || p->speed > m->vmax ||
            p->range < m->rmin - padding || p->range > m->rmax + padding ||
            implied <
                start_time - m->tolerance -
                    (filter_only ? 142 / m->vmin + 142 / sound_speed : 0) ||
            implied > end_time + m->tolerance +
                          (filter_only ? 142 / m->vmin + 142 / sound_speed : 0))
          continue;
        if (matches[e].n == MAX_MATCHES)
          fail("Event association budget exceeded; narrow measurement ranges");
        matches[e].p[matches[e].n++] = *p;
      }
    }
    int possible = 1;
    for (int e = 0; e < event_count; e++)
      if (!matches[e].n)
        possible = 0;
    if (possible) {
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
      if (event_count == 1 && !spectral_mode && !filter_only) {
        bounded_single_event(cell, matches, result, leaders);
        goto cell_done;
      }
#endif
      for (int first = 0; first < matches[0].n; first++) {
        Approach *p = &matches[0].p[first];
        double implied = p->arrival - measurements[0].cpa,
               tol =
                   measurements[0].tolerance +
                   (filter_only ? 142 / measurements[0].vmin + 142 / sound_speed
                                : 0);
        double low = fmax(start_time, implied - tol),
               high = fmin(end_time, implied + tol),
               clock =
                   start_time +
                   ceil((low - start_time) / time_step - .00001) * time_step;
        for (; clock <= high + .00001; clock += time_step) {
#ifndef DOPPLER_REFERENCE
          // Intersect event clock intervals before doing any acoustic fitting.
          // Keep original first/clock/event/association order, including ties.
          int active[MAX_EVENTS][MAX_MATCHES], active_count[MAX_EVENTS] = {0},
                                               feasible = 1;
          for (int e = 0; e < event_count; e++) {
            double tolerance =
                measurements[e].tolerance +
                (filter_only ? 142 / measurements[e].vmin + 142 / sound_speed
                             : 0) +
                .00001;
            for (int j = 0; j < matches[e].n; j++) {
              if (!e && j != first)
                continue;
              if (fabs(matches[e].p[j].arrival - measurements[e].cpa - clock) <=
                  tolerance)
                active[e][active_count[e]++] = j;
            }
            if (!active_count[e]) {
              feasible = 0;
              break;
            }
          }
          if (!feasible)
            continue;
#endif
          memset(assignment, 0, sizeof *assignment);
          assignment->best_score = -1e30;
          assignment->all = all;
          assignment->nall = nall;
          assignment->leaders = leaders;
          assignment->cell = cell;
          assignment->clock = clock;
          int valid = 1;
          for (int e = 0; e < event_count; e++) {
#ifndef DOPPLER_REFERENCE
            for (int option = 0; option < active_count[e]; option++) {
              int j = active[e][option];
#else
            for (int j = 0; j < matches[e].n; j++) {
#endif
              Approach *cp = &matches[e].p[j];
              if (!e && j != first)
                continue;
              if (fabs(cp->arrival - measurements[e].cpa - clock) >
                  measurements[e].tolerance +
                      (filter_only
                           ? 142 / measurements[e].vmin + 142 / sound_speed
                           : 0) +
                      .00001)
                continue;
              EventFit fit;
              if (filter_only)
                fit = (EventFit){.track = cp->track, .score = 0, .cpa = *cp};
              else if (!evaluate_event(&events[e], &measurements[e], cell, cp,
                                       clock, &fit, 1e30))
                continue;
              assignment->fit[e][assignment->n[e]++] = fit;
              atomic_fetch_add(&scored_pairs, 1);
            }
            if (!assignment->n[e]) {
              valid = 0;
              break;
            }
          }
          if (!valid)
            continue;
          assign_events(assignment, 0, 0);
          if (assignment->best_score <= -1e29)
            continue;
          atomic_fetch_add(&physics_survivors, 1);
          double rank = -assignment->best_score;
          if (rank < result->rank) {
            result->rank = rank;
            result->score = assignment->best_score;
            result->cell.clock = clock;
            memcpy(result->fits, assignment->best, sizeof result->fits);
            double sum = 0;
            if (!filter_only)
              for (int e = 0; e < event_count; e++)
                sum += pow(result->fits[e].rmse / result->fits[e].rest, 2);
            result->rmse = filter_only ? 0 : sqrt(sum / event_count);
          }
          if (filter_only)
            break;
        }
        if (filter_only && result->rank < 1e29)
          break;
      }
    }
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
  cell_done:
    if (event_count == 1 && !spectral_mode && !filter_only)
      heat_insert(result->rank);
#endif
    ;
    size_t done = atomic_fetch_add(&completed, 1) + 1;
    if (!(done % 128) || done == cell_count)
      fprintf(stderr, "{\"completed\":%zu,\"total\":%zu}\n", done, cell_count);
  }
  free(all);
  free(matches);
  free(assignment);
#ifndef DOPPLER_REFERENCE
  free(arrival_values);
  free(arrival_stamps);
  arrival_values = NULL;
  arrival_stamps = NULL;
#endif
  return NULL;
}
static int compare_method(const void *a, const void *b) {
  const MethodResult *x = a, *y = b;
  if (x->rank != y->rank)
    return x->rank < y->rank ? -1 : 1;
  if (x->cell.lat != y->cell.lat)
    return x->cell.lat < y->cell.lat ? -1 : 1;
  return x->cell.lon < y->cell.lon ? -1 : x->cell.lon > y->cell.lon;
}
static int compare_leader(const void *a, const void *b) {
  return compare_method(&((const FlightLeader *)a)->result,
                        &((const FlightLeader *)b)->result);
}
static void write_method_candidate(FILE *out, MethodResult *r,
                                   int include_model) {
  Cell *cell = &r->cell;
  fprintf(out,
          "{\"lat\":%.7f,\"lon\":%.7f,\"height\":%.3f,\"loss\":%.8f,"
          "\"rankLoss\":%.8f,\"score\":%.6f,\"clock\":%.3f,\"flights\":[",
          cell->lat, cell->lon, cell->height, r->rmse, r->rank, r->score,
          cell->clock);
  for (int e = 0; e < event_count; e++)
    fprintf(out, "%s\"%s\"", e ? "," : "", tracks[r->fits[e].track].id);
  fputs("]", out);
  if (!filter_only) {
    fputs(",\"eventFits\":[", out);
    for (int e = 0; e < event_count; e++) {
      EventFit *fit = &r->fits[e];
      fprintf(
          out,
          "%s{\"eventId\":%d,\"restHz\":%.4f,\"rmseHz\":%.4f,\"score\":%.5f,"
          "\"cpaTime\":%.3f,\"cpaSlantM\":%.3f,\"speedMps\":%.3f,\"modeled\":[",
          e ? "," : "", events[e].id, fit->rest, fit->rmse, fit->score,
          fit->cpa.arrival, fit->cpa.range, fit->cpa.speed);
      for (int j = 0; include_model && j < events[e].n; j++) {
        double k, range;
        doppler(&tracks[fit->track], cell, cell->clock + events[e].t[j], &k,
                &range);
        fprintf(out, "%s[%.3f,%.4f]", j ? "," : "", events[e].t[j],
                fit->rest * k);
      }
      fputs("]}", out);
    }
    fputs("]", out);
  }
  fputs("}", out);
}
static void locate(int argc, char **argv) {
  if (argc < 15)
    fail("locate RIDGES TRACKS CELLS MEASUREMENTS SPECTRUM START END STEP "
         "THREADS SOUND_SPEED OUTPUT FILTER_ONLY SPECTRAL [SILENCE]");
  start_time = strtod(argv[7], NULL);
  end_time = strtod(argv[8], NULL);
  time_step = strtod(argv[9], NULL);
  int count = atoi(argv[10]);
  sound_speed = strtod(argv[11], NULL);
  filter_only = atoi(argv[13]);
  spectral_mode = atoi(argv[14]);
  silence_enabled = argc > 15 ? atoi(argv[15]) : 0;
  if (!isfinite(start_time) || !isfinite(end_time) || end_time < start_time ||
      end_time - start_time > 10800 || !isfinite(time_step) ||
      time_step < .25 || time_step > 3600 || !isfinite(sound_speed) ||
      sound_speed < 290 || sound_speed > 370)
    fail("Invalid method settings");
  if (!tracks) {
    load_events(argv[2]);
    load_tracks(argv[3]);
#ifndef DOPPLER_REFERENCE
    build_segment_trees();
#endif
    load_measurements(argv[5]);
  }
  cell_count = 0;
  atomic_store(&next_cell, 0);
  atomic_store(&completed, 0);
  atomic_store(&physics_survivors, 0);
  atomic_store(&scored_pairs, 0);
  atomic_store(&silence_rejections, 0);
  memset(thread_leaders, 0, sizeof thread_leaders);
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
  atomic_store(&bounded_intervals, 0);
  atomic_store(&pruned_intervals, 0);
  atomic_store(&exact_clock_fits, 0);
  atomic_store(&analytic_evaluations, 0);
  atomic_store(&analytic_pruned, 0);
#endif
  load_cells(argv[4]);
  if (!filter_only && spectral_mode && !observed_spectrum.values)
    load_spectrogram(argv[6]);
  method_results = allocate(cell_count, sizeof(MethodResult));
  long cpus = sysconf(_SC_NPROCESSORS_ONLN);
  if (cpus < 1)
    cpus = 1;
  if (count < 1)
    count = cpus < 8 ? (int)cpus : 8;
  if (count > cpus)
    count = (int)cpus;
  if (count > 32)
    count = 32;
  pthread_t workers[32];
  int created = 0;
  struct timespec before, after;
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
  load_incumbents(argc > 16 ? argv[16] : NULL);
  atomic_store(&heat_cutoff, external_heat);
  heat_count = 0;
#endif
  clock_gettime(CLOCK_MONOTONIC, &before);
  for (int i = 0; i < count; i++) {
    if (pthread_create(&workers[created], NULL, method_thread,
                       &thread_leaders[created]))
      break;
    created++;
  }
  if (!created)
    fail("Cannot start method threads");
  for (int i = 0; i < created; i++)
    pthread_join(workers[i], NULL);
  clock_gettime(CLOCK_MONOTONIC, &after);
  double elapsed =
      after.tv_sec - before.tv_sec + (after.tv_nsec - before.tv_nsec) / 1e9;
  qsort(method_results, cell_count, sizeof(MethodResult), compare_method);
  FILE *out = fopen(argv[12], "w");
  if (!out)
    fail("Cannot write method output");
  fprintf(out,
          "{\"methodVersion\":2,\"scoreMode\":\"%s\",\"threads\":%d,"
          "\"cellsEvaluated\":%zu,\"trials\":%llu,\"silenceRejections\":%llu,"
          "\"physicsSurvivors\":%llu,\"elapsedSeconds\":%.6f,\"eventCount\":%d,"
          "\"candidates\":[",
          filter_only     ? "filter"
          : spectral_mode ? "spectral"
                          : "trace",
          created, cell_count, (unsigned long long)atomic_load(&scored_pairs),
          (unsigned long long)atomic_load(&silence_rejections),
          (unsigned long long)atomic_load(&physics_survivors), elapsed,
          event_count);
  int written = 0;
  for (size_t i = 0; i < cell_count && (filter_only || written < 1200); i++) {
    MethodResult *r = &method_results[i];
    if (r->rank > 1e29)
      continue;
    if (written++)
      fputs(",", out);
    write_method_candidate(out, r, 1);
  }
  fputs("],\"flightLeaders\":[", out);
  // Include losing associations at each cell: clusters must not hide other
  // flight tuples.
  FlightLeaders combined = {0};
  for (int t = 0; t < created; t++) {
    for (int j = 0; j < thread_leaders[t].count; j++)
      retain_flight_leader(&combined, &thread_leaders[t].entries[j].result);
    free(thread_leaders[t].entries);
  }
  if (combined.count > 1)
    qsort(combined.entries, combined.count, sizeof(FlightLeader),
          compare_leader);
  for (int j = 0; j < combined.count; j++) {
    if (j)
      fputs(",", out);
    write_method_candidate(out, &combined.entries[j].result, j < 50);
  }
  free(combined.entries);
  fputs("]", out);
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
  fprintf(out,
          ",\"bounds\":{\"intervals\":%llu,\"pruned\":%llu,\"exactClockFits\":%"
          "llu,\"analyticEvaluations\":%llu,\"analyticPruned\":%llu}",
          (unsigned long long)atomic_load(&bounded_intervals),
          (unsigned long long)atomic_load(&pruned_intervals),
          (unsigned long long)atomic_load(&exact_clock_fits),
          (unsigned long long)atomic_load(&analytic_evaluations),
          (unsigned long long)atomic_load(&analytic_pruned));
#endif
  fputs("}\n", out);
  fclose(out);
  free(cells);
  cells = NULL;
  free(method_results);
  method_results = NULL;
}
// Length-prefixed paths avoid quoting, shell evaluation and whitespace
// ambiguity. One loaded trajectory dataset serves all physics/scoring chunks in
// a batch.
static void serve(int argc, char **argv) {
  if (argc != 10)
    fail("serve RIDGES TRACKS MEASUREMENTS SPECTRUM THREADS SOUND_SPEED "
         "SPECTRAL SILENCE");
  printf("{\"ready\":true,\"pid\":%ld}\n", (long)getpid());
  fflush(stdout);
  unsigned char header[48];
  for (;;) {
    size_t n = fread(header, 1, sizeof header, stdin);
    if (!n && feof(stdin))
      break;
    if (n != sizeof header || memcmp(header, "SGQ1", 4))
      fail("Malformed worker request");
    uint32_t request = le32(header + 4),
             lengths[3] = {le32(header + 36), le32(header + 40),
                           le32(header + 44)};
    char paths[3][4097];
    for (int i = 0; i < 3; i++) {
      if (!lengths[i] || lengths[i] > 4096 ||
          fread(paths[i], 1, lengths[i], stdin) != lengths[i])
        fail("Malformed worker path");
      if (memchr(paths[i], 0, lengths[i]))
        fail("NUL in worker path");
      paths[i][lengths[i]] = 0;
    }
    double from, to, step;
    memcpy(&from, header + 8, 8);
    memcpy(&to, header + 16, 8);
    memcpy(&step, header + 24, 8);
    char a[64], b[64], c[64], filter[16];
    snprintf(a, sizeof a, "%.17g", from);
    snprintf(b, sizeof b, "%.17g", to);
    snprintf(c, sizeof c, "%.17g", step);
    snprintf(filter, sizeof filter, "%u", le32(header + 32));
    char *request_argv[] = {argv[0], "locate", argv[2],  argv[3], paths[0],
                            argv[4], argv[5],  a,        b,       c,
                            argv[6], argv[7],  paths[1], filter,  argv[8],
                            argv[9], paths[2]};
    locate(17, request_argv);
    printf("{\"request\":%u,\"complete\":true}\n", request);
    fflush(stdout);
  }
  for (size_t f = 0; f < track_count; f++) {
    free(tracks[f].p);
#ifndef DOPPLER_REFERENCE
    free(segment_trees[f].nodes);
#endif
  }
  free(tracks);
  free(observed_spectrum.values);
}
