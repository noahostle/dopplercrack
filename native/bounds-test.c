/* Standalone property audit: compile/run via check-doppler-optimization.mjs. */
#define main doppler_worker_main
#include "worker.c"
#undef main
#include <assert.h>
static uint32_t random_state = 14571;
static double uniform(void) {
  random_state = random_state * 1664525U + 1013904223U;
  return random_state / 4294967296.0;
}
int main(int argc, char **argv) {
  if (argc != 6)
    fail("bounds-test RIDGES TRACKS CELLS MEASUREMENTS UTC_START");
  load_events(argv[1]);
  assert(event_count == 1);
  load_tracks(argv[2]);
  load_cells(argv[3]);
  sound_speed = 343;
  load_measurements(argv[4]);
  double base = strtod(argv[5], NULL);
  start_time = base - 70;
  end_time = base + 130;
  unsigned long long samples = 0, intervals = 0, analytic_checks = 0;
  for (size_t c = 0; c < cell_count && c < 16; c++)
    for (size_t f = 0; f < track_count; f++) {
      if (tracks[f].n < 2)
        continue;
      Approach approach = {.track = (int)f};
      double clocks[2];
      CurvePiece *pieces = allocate(tracks[f].n, sizeof(CurvePiece));
      ClockSearch s = {.cell = &cells[c],
                       .cpa = &approach,
                       .pieces = pieces,
                       .clocks = clocks};
      for (int i = 0; i < events[0].n; i++)
        s.total_weight += events[0].w[i];
      if (!make_curve_pieces(&s)) {
        free(pieces);
        continue;
      }
      for (int trial = 0; trial < 100; trial++) {
        clocks[0] = base - 70 + 140 * uniform();
        clocks[1] = clocks[0] + 60 * uniform();
        double lower[MAX_POINTS], upper[MAX_POINTS];
        int valid = 1;
        for (int i = 0; i < events[0].n; i++) {
          if (!factor_interval(&s, clocks[0] + events[0].t[i],
                               clocks[1] + events[0].t[i], &lower[i],
                               &upper[i])) {
            valid = 0;
            break;
          }
          for (int j = 0; j < 9; j++) {
            double t = clocks[0] +
                       (clocks[1] - clocks[0]) * (j == 0   ? 0
                                                  : j == 1 ? 1
                                                           : uniform()) +
                       events[0].t[i],
                   k, r;
            if (doppler(&tracks[f], &cells[c], t, &k, &r)) {
              assert(k >= lower[i] && k <= upper[i]);
              samples++;
            }
          }
        }
        if (!valid)
          continue;
        double bound =
            cone_lower_bound(&events[0], &measurements[0], lower, upper, 1e30) /
            s.total_weight;
        for (int j = 0; j < 9; j++) {
          EventFit fit;
          double clock = clocks[0] + (clocks[1] - clocks[0]) * j / 8;
          if (evaluate_event(&events[0], &measurements[0], &cells[c], &approach,
                             clock, &fit, 1e30)) {
            assert(bound <= -fit.score + 1e-9);
            assert(analytic_loss_bound(&s, clock) <= -fit.score + 1e-9);
            analytic_checks++;
          }
        }
        intervals++;
      }
      free(pieces);
    }
  printf("{\"factorSamples\":%llu,\"lossIntervals\":%llu,\"analyticChecks\":%"
         "llu,\"seed\":14571}\n",
         samples, intervals, analytic_checks);
  return 0;
}
