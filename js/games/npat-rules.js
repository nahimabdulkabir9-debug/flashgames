// Pure NPAT scoring helpers, kept separate from the browser game so they can
// be tested with plain Node (no Firebase imports needed).

/**
 * Should this answer count as valid?
 * A dictionary hit always counts. Otherwise more ✅ than ❌ is required:
 * ties and no votes reject.
 */
export function answerApproved({ check, votes = {}, ownerUid, key }) {
  if (check === 1) return true;
  let yes = 0;
  let no = 0;
  Object.entries(votes).forEach(([voter, marks]) => {
    if (voter === ownerUid) return;
    const id = `${ownerUid}_${key}`;
    if (marks?.[id] === 1) yes += 1;
    else if (marks?.[id] === 0) no += 1;
  });
  return yes > no;
}
