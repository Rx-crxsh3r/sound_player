// Shared between both platforms' audio capture threads (src/platform/*) —
// this code only ever sees a slice of mono f32 samples, so it doesn't care
// where they came from (WASAPI on Windows, PulseAudio on Linux).

// Applies a Hann window, runs an FFT of length `samples.len()`, then
// returns 24 RMS band energies scaled to 0.0–1.0 using `gain`.
pub fn compute_bands(
    samples:  &[f32],
    sample_rate: f32,
    planner:  &mut rustfft::FftPlanner<f32>,
    gain:     f32,
) -> [f32; 24] {
    use rustfft::num_complex::Complex;

    let n = samples.len();
    let pi = std::f32::consts::PI;

    // Hann window → reduces spectral leakage.
    let mut buf: Vec<Complex<f32>> = samples.iter().enumerate().map(|(i, &s)| {
        let w = 0.5 * (1.0 - (2.0 * pi * i as f32 / (n - 1) as f32).cos());
        Complex { re: s * w, im: 0.0 }
    }).collect();

    planner.plan_fft_forward(n).process(&mut buf);

    let bin_hz  = sample_rate / n as f32;
    let nyquist = n / 2;

    // 24 logarithmically-spaced bands — one per EQ bar.
    const EDGES: [f32; 25] = [
         25.0,  40.0,  60.0,  80.0, 100.0, 125.0, 160.0, 200.0,
        250.0, 315.0, 400.0, 500.0, 630.0, 800.0, 1_000.0, 1_250.0,
        1_600.0, 2_000.0, 2_500.0, 3_150.0, 4_000.0, 6_300.0, 10_000.0, 16_000.0, 20_000.0,
    ];

    let mut out = [0.0f32; 24];
    for i in 0..24 {
        let lo = ((EDGES[i]     / bin_hz).round() as usize).clamp(1, nyquist);
        let hi = ((EDGES[i + 1] / bin_hz).round() as usize).clamp(lo + 1, nyquist + 1);
        let count = (hi - lo) as f32;
        // RMS of magnitudes in band
        let energy = buf[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / count;
        out[i] = (energy.sqrt() / n as f32 * gain).clamp(0.0, 1.0);
    }
    out
}
