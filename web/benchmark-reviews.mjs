/** Human review is a separate, append-only overlay; it never changes automated gold agreement. */
const keyOf = row => JSON.stringify([row.group, row.snapshot, row.round, row.variant, row.question_id]);
export function reviewedReport(report, reviews = []) {
  if (!report) return report;
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at))) latest.set(keyOf(review), review);
  const rows = report.rows.map(row => {
    const review = latest.get(keyOf(row));
    return { ...row, score: { ...row.score, human_semantic_status: review?.judgment || 'PENDING' },
      semantic_review: review || null };
  });
  return { ...report, rows, semantic_reviews: reviews,
    human_review_seconds: reviews.reduce((n, r) => n + r.duration_seconds, 0),
    summary: report.summary.map(summary => ({ ...summary,
      human_semantic_pending: rows.filter(r => r.variant === summary.variant && !r.semantic_review).length,
      human_semantic_uncertain: rows.filter(r => r.variant === summary.variant && r.semantic_review?.judgment === 'UNCERTAIN').length,
      human_semantic_unsupported: rows.filter(r => r.variant === summary.variant && r.semantic_review?.judgment === 'UNSUPPORTED').length
    })) };
}
