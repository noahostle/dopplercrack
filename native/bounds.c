/* Exact discrete branch-and-bound for the single-event trace objective.
 * All retained leaves use evaluate_event, never the bounding approximation.
 * See DOPPLERCRACK_MATH.md for the relaxation and numerical guards.
 */
#if !defined(DOPPLER_REFERENCE) && !defined(DOPPLER_UNBOUNDED)
#define HEAT_COUNT 1200
static double heat_heap[HEAT_COUNT];
static size_t heat_count;
static pthread_mutex_t heat_mutex = PTHREAD_MUTEX_INITIALIZER;
static _Atomic double heat_cutoff;
static double external_heat = 1e30, external_leaders[MAX_TRACKS];
static atomic_ullong bounded_intervals, pruned_intervals, exact_clock_fits;
static atomic_ullong analytic_evaluations, analytic_pruned;
typedef struct {
  double from, to, pad;
  long double cpa, v2, perp2, beta2;
  double relative_cpa, fast_v2, fast_perp2, one_minus_beta2;
  int loose;
} CurvePiece;
typedef struct {
  const Cell *cell;
  const Approach *cpa;
  FlightLeaders *leaders;
  MethodResult *result;
  CurvePiece *pieces;
  size_t piece_count;
  const double *clocks;
  int seed, first, can_bound;
  double total_weight;
  double time_guard;
} ClockSearch;
static void heat_insert(double rank) {
  if (rank > 1e29)
    return;
  pthread_mutex_lock(&heat_mutex);
  if (heat_count < HEAT_COUNT) {
    size_t i = heat_count++;
    while (i && heat_heap[(i - 1) / 2] < rank) {
      heat_heap[i] = heat_heap[(i - 1) / 2];
      i = (i - 1) / 2;
    }
    heat_heap[i] = rank;
  } else if (rank < heat_heap[0]) {
    size_t i = 0;
    while (i * 2 + 1 < heat_count) {
      size_t child = i * 2 + 1;
      if (child + 1 < heat_count && heat_heap[child + 1] > heat_heap[child])
        child++;
      if (heat_heap[child] <= rank)
        break;
      heat_heap[i] = heat_heap[child];
      i = child;
    }
    heat_heap[i] = rank;
  }
  if (heat_count == HEAT_COUNT)
    atomic_store(&heat_cutoff, fmin(external_heat, heat_heap[0]));
  pthread_mutex_unlock(&heat_mutex);
}
static double tuple_cutoff(const FlightLeaders *leaders, int track) {
  uint32_t hash = (2166136261U ^ (uint32_t)track) * 16777619U;
  for (int n = leaders->buckets[hash % 16384]; n;
       n = leaders->entries[n - 1].next)
    if (leaders->entries[n - 1].result.fits[0].track == track)
      return fmin(external_leaders[track], leaders->entries[n - 1].result.rank);
  return external_leaders[track];
}
static void load_incumbents(const char *path) {
  external_heat = 1e30;
  for (size_t f = 0; f < track_count; f++)
    external_leaders[f] = 1e30;
  if (!path || !strcmp(path, "-") || event_count != 1 || spectral_mode ||
      filter_only)
    return;
  FILE *file = fopen(path, "r");
  if (!file)
    fail("Cannot read search incumbents");
  char line[256], id[32];
  double rank;
  while (fgets(line, sizeof line, file)) {
    if (sscanf(line, "heat,%lf", &rank) == 1) {
      if (isfinite(rank) && rank >= 0)
        external_heat = rank + 1e-7 * (1 + fabs(rank));
    } else if (sscanf(line, "flight,%31[^,],%lf", id, &rank) == 2 &&
               isfinite(rank) && rank >= 0)
      for (size_t f = 0; f < track_count; f++)
        if (!strcmp(id, tracks[f].id)) {
          external_leaders[f] = rank + 1e-7 * (1 + fabs(rank));
          break;
        }
  }
  fclose(file);
}
static double required_loss(const ClockSearch *s) {
  // A losing cell may be omitted only if it also cannot improve its flight
  // leader. Thread-local leaders weaken pruning, but never invalidate it.
  return fmax(fmin(s->result->rank, atomic_load(&heat_cutoff)),
              tuple_cutoff(s->leaders, s->cpa->track));
}
static int make_curve_pieces(ClockSearch *s) {
  Track *track = &tracks[s->cpa->track];
  s->piece_count = track->n - 1;
  double magnitude =
      fmax(fmax(fabs(start_time), fabs(end_time)),
           fmax(fabs(track->p[0].t), fabs(track->p[track->n - 1].t)));
  s->time_guard = 4e-6 + 8 * (nextafter(magnitude, INFINITY) - magnitude);
  for (size_t j = 0; j < s->piece_count; j++) {
    Position a = track->p[j], b = track->p[j + 1];
    CurvePiece *p = &s->pieces[j];
    p->from = vertex_arrival(track, s->cell, j);
    p->to = vertex_arrival(track, s->cell, j + 1);
    if (!(p->to > p->from) || !(b.t > a.t))
      return 0;
    long double dt = (long double)b.t - a.t;
    long double vx = ((long double)b.x - a.x) / dt,
                vy = ((long double)b.y - a.y) / dt,
                vz = ((long double)b.z - a.z) / dt;
    long double rx = (long double)a.x - s->cell->x,
                ry = (long double)a.y - s->cell->y,
                rz = (long double)a.z - s->cell->z;
    p->v2 = vx * vx + vy * vy + vz * vz;
    long double offset = p->v2 ? -(rx * vx + ry * vy + rz * vz) / p->v2 : 0;
    p->cpa = (long double)a.t + offset;
    rx += vx * offset;
    ry += vy * offset;
    rz += vz * offset;
    p->perp2 = rx * rx + ry * ry + rz * rz;
    p->beta2 = p->v2 / ((long double)sound_speed * sound_speed);
    p->relative_cpa = (double)(p->cpa - start_time);
    p->fast_v2 = (double)p->v2;
    p->fast_perp2 = (double)p->perp2;
    p->one_minus_beta2 = (double)(1 - p->beta2);
    // The reference bracket assumes a subsonic, increasing arrival map.
    // Retain exhaustive scoring for data that violates that assumption.
    if (p->beta2 >= .85L * .85L)
      return 0;
    p->loose = dt > max_gap || p->perp2 < 1e-8L;
    long double radius = sqrtl(p->perp2), one = 1 - p->beta2;
    // |dk/dt_arrival| <= v²/[c R (1-beta²)^(3/2)]. The time guard
    // covers the reference's 1 us stopping test and UTC-double rounding.
    p->pad =
        p->loose
            ? 1
            : nextafter((double)(s->time_guard * p->v2 /
                                 (sound_speed * radius * one * sqrtl(one))) +
                            1e-6,
                        INFINITY);
  }
  return 1;
}
static double piece_factor(const CurvePiece *p, double arrival) {
  long double h = (long double)arrival - p->cpa, one = 1 - p->beta2;
  long double r = sqrtl(p->v2 * h * h + one * p->perp2);
  if (!r)
    return NAN;
  return (double)((1 - p->v2 * h / (sound_speed * r)) / one);
}
static int factor_interval(const ClockSearch *s, double from, double to,
                           double *lower, double *upper) {
  from = nextafter(from - s->time_guard, -INFINITY);
  to = nextafter(to + s->time_guard, INFINITY);
  size_t lo = 0, hi = s->piece_count;
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (s->pieces[mid].to < from)
      lo = mid + 1;
    else
      hi = mid;
  }
  *lower = INFINITY;
  *upper = -INFINITY;
  for (size_t j = lo; j < s->piece_count && s->pieces[j].from <= to; j++) {
    const CurvePiece *p = &s->pieces[j];
    if (p->loose) {
      *lower = fmin(*lower, nextafter(1 / 1.85 - 1e-6, -INFINITY));
      *upper = fmax(*upper, nextafter(1 / .15 + 1e-6, INFINITY));
      continue;
    }
    double left = piece_factor(p, fmax(from, p->from)),
           right = piece_factor(p, fmin(to, p->to));
    if (!isfinite(left) || !isfinite(right)) {
      *lower = nextafter(1 / 1.85 - 1e-6, -INFINITY);
      *upper = nextafter(1 / .15 + 1e-6, INFINITY);
      return 1;
    }
    *lower = fmin(*lower, nextafter(right - p->pad, -INFINITY));
    *upper = fmax(*upper, nextafter(left + p->pad, INFINITY));
  }
  return *lower <= *upper;
}
// Convex cone relaxation: a single rest frequency must explain all samples.
// Every tangent lies below the convex loss, so minimizing that affine tangent
// on [fmin,fmax] yields a lower bound even before bisection has converged.
static double cone_lower_bound(const Event *e, const Measurement *m,
                               const double *lower, const double *upper,
                               double target) {
  double lo = m->fmin, hi = m->fmax, best = 0, energy = 0;
  for (int i = 0; i < e->n; i++)
    energy += e->w[i] * e->f[i] * e->f[i];
  for (int iteration = 0; iteration < 18; iteration++) {
    double f = (lo + hi) / 2, value = 0, derivative = 0;
    for (int i = 0; i < e->n; i++) {
      double k = f * lower[i] > e->f[i]   ? lower[i]
                 : f * upper[i] < e->f[i] ? upper[i]
                                          : 0;
      if (!k)
        continue;
      double residual = f * k - e->f[i];
      value += e->w[i] * residual * residual;
      derivative += 2 * e->w[i] * k * residual;
    }
    double dual =
        value + derivative * (derivative < 0 ? m->fmax - f : m->fmin - f);
    best = fmax(best, dual);
    if (target < 1e29) {
      // A primal witness <= target proves this relaxation cannot prune.
      // A dual witness > target proves the entire interval can be pruned.
      if (value <= target)
        return 0;
      if (best - 1e-10 * (1 + energy) > target)
        break;
    }
    if (derivative < 0)
      lo = f;
    else
      hi = f;
  }
  return fmax(0, nextafter(best - 1e-10 * (1 + energy), -INFINITY));
}
static double clock_interval_bound(const ClockSearch *s, int low, int high,
                                   double cutoff) {
  double lower[MAX_POINTS], upper[MAX_POINTS];
  const Event *e = &events[0];
  for (int i = 0; i < e->n; i++)
    if (!factor_interval(s, s->clocks[low] + e->t[i], s->clocks[high] + e->t[i],
                         &lower[i], &upper[i]))
      return INFINITY;
  return cone_lower_bound(e, &measurements[0], lower, upper,
                          cutoff * s->total_weight) /
         s->total_weight;
}
static double analytic_loss_bound(const ClockSearch *s, double clock) {
  const Event *event = &events[0];
  const Measurement *m = &measurements[0];
  double k[MAX_POINTS], a = 0, b = 0, uncertainty = 0, energy = 0;
  size_t segment = 0;
  for (int i = 0; i < event->n; i++) {
    double arrival = clock + event->t[i];
    if (!i || arrival < s->pieces[segment].from) {
      size_t lo = 0, hi = s->piece_count;
      while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (s->pieces[mid].to < arrival)
          lo = mid + 1;
        else
          hi = mid;
      }
      segment = lo;
    }
    while (segment < s->piece_count && s->pieces[segment].to < arrival)
      segment++;
    if (segment >= s->piece_count)
      return 0;
    const CurvePiece *p = &s->pieces[segment];
    // At derivative discontinuities or invalid/gapped segments, let the exact
    // solver decide. A tolerance-neighbourhood cannot use just one branch.
    if (p->loose || arrival < p->from + 2 * s->time_guard ||
        arrival > p->to - 2 * s->time_guard)
      return 0;
    double h = (clock - start_time) + event->t[i] - p->relative_cpa;
    double r = sqrt(p->fast_v2 * h * h + p->one_minus_beta2 * p->fast_perp2);
    if (!r)
      return 0;
    k[i] = (1 - p->fast_v2 * h / (sound_speed * r)) / p->one_minus_beta2;
    a += event->w[i] * k[i] * event->f[i];
    b += event->w[i] * k[i] * k[i];
    uncertainty += event->w[i] * p->pad * p->pad;
    energy += event->w[i] * event->f[i] * event->f[i];
  }
  double rest = fmax(m->fmin, fmin(m->fmax, a / b)), error = 0;
  for (int i = 0; i < event->n; i++) {
    double residual = event->f[i] - rest * k[i];
    error += event->w[i] * residual * residual;
  }
  // Distance to a set is 1-Lipschitz. The unknown reference factor vector is
  // within ||epsilon||_W of this analytical vector, for every allowed f0.
  double distance = fmax(0, sqrt(fmax(0, error - 1e-10 * (1 + energy))) -
                                m->fmax * sqrt(uncertainty));
  return nextafter(distance * distance / s->total_weight, -INFINITY);
}
static void score_clock(ClockSearch *s, int tick) {
  double clock = s->clocks[tick], cutoff = required_loss(s);
  EventFit fit;
  if (s->can_bound && cutoff < 1e29) {
    atomic_fetch_add(&analytic_evaluations, 1);
    if (analytic_loss_bound(s, clock) > cutoff + 1e-10 * (1 + fabs(cutoff))) {
      atomic_fetch_add(&analytic_pruned, 1);
      return;
    }
  }
  atomic_fetch_add(&exact_clock_fits, 1);
  if (!evaluate_event(&events[0], &measurements[0], s->cell, s->cpa, clock,
                      &fit, required_loss(s)))
    return;
  atomic_fetch_add(&scored_pairs, 1);
  atomic_fetch_add(&physics_survivors, 1);
  MethodResult r = {.cell = *s->cell,
                    .rank = -fit.score,
                    .score = fit.score,
                    .rmse = fit.rmse / fit.rest,
                    .association_order = s->first,
                    .trial_order = tick};
  r.cell.clock = clock;
  r.fits[0] = fit;
  retain_flight_leader(s->leaders, &r);
  if (r.rank < s->result->rank ||
      (r.rank == s->result->rank &&
       (r.association_order < s->result->association_order ||
        (r.association_order == s->result->association_order &&
         r.trial_order < s->result->trial_order))))
    *s->result = r;
}
static void search_clock_interval(ClockSearch *s, int low, int high) {
  if (low > high)
    return;
  double cutoff = required_loss(s);
  if (s->can_bound && cutoff < 1e29 && high - low >= 2) {
    atomic_fetch_add(&bounded_intervals, 1);
    double bound = clock_interval_bound(s, low, high, cutoff);
    if (bound > cutoff + 1e-10 * (1 + fabs(cutoff))) {
      atomic_fetch_add(&pruned_intervals, 1);
      return;
    }
  }
  if (high - low < 8) {
    for (int i = low; i <= high; i++)
      if (i != s->seed)
        score_clock(s, i);
    return;
  }
  int middle = low + (high - low) / 2;
  search_clock_interval(s, low, middle);
  search_clock_interval(s, middle + 1, high);
}
static void bounded_single_event(const Cell *cell, const Matches *matches,
                                 MethodResult *result, FlightLeaders *leaders) {
  double weight = 0;
  for (int i = 0; i < events[0].n; i++)
    weight += events[0].w[i];
  for (int first = 0; first < matches[0].n; first++) {
    const Approach *p = &matches[0].p[first];
    Measurement *m = &measurements[0];
    double implied = p->arrival - m->cpa,
           low = fmax(start_time, implied - m->tolerance),
           high = fmin(end_time, implied + m->tolerance);
    double clock =
        start_time + ceil((low - start_time) / time_step - .00001) * time_step;
    double clocks[512];
    int count = 0;
    // Reproduce the reference's repeated addition, even for non-binary steps.
    for (; clock <= high + .00001; clock += time_step)
      if (fabs(p->arrival - m->cpa - clock) <= m->tolerance + .00001) {
        if (count == 512)
          fail("Clock interval budget exceeded");
        clocks[count++] = clock;
      }
    if (!count)
      continue;
    Track *track = &tracks[p->track];
    CurvePiece *pieces = count > 8 ? allocate(track->n, sizeof(CurvePiece)) : NULL;
    ClockSearch s = {.cell = cell,
                     .cpa = p,
                     .leaders = leaders,
                     .result = result,
                     .pieces = pieces,
                     .clocks = clocks,
                     .seed = -1,
                     .first = first,
                     .total_weight = weight};
    // A known clock needs no interval tree. Retain the cheaper original trial
    // calculation rather than preparing an entire trajectory for a few ticks.
    if (count <= 8) {
      for (int tick = 0; tick < count; tick++)
        score_clock(&s, tick);
      continue;
    }
    s.can_bound = make_curve_pieces(&s);
    double cutoff = required_loss(&s);
    if (s.can_bound && count > 8 && cutoff < 1e29 &&
        clock_interval_bound(&s, 0, count - 1, cutoff) >
            cutoff + 1e-10 * (1 + fabs(cutoff))) {
      atomic_fetch_add(&pruned_intervals, 1);
      free(pieces);
      continue;
    }
    s.seed = count / 2;
    score_clock(&s, s.seed);
    search_clock_interval(&s, 0, count - 1);
    free(pieces);
  }
}
#endif
