// Screenshots a job's agent took, deleted when the job's session ends so they do not pile up.
//
// The office hook writes each screenshot into one folder on this computer with a note of the job
// that took it (bin/lib/shot-capture.cjs, tagged by native.cjs). When the job ends, parked or
// finished, the runner clears that job's screenshots; the ones its owner marked Keep on Projects →
// Screenshots stay. A worker that stopped mid-job never got that far, so starting it sweeps what
// such jobs left behind. Everything here is on this computer's disk; nothing is sent anywhere.

'use strict';

const os = require('os');
const path = require('path');
const { createShots } = require('../crew/shots.cjs');

/** The folder the hook writes to: the same answer bin/aop-send.cjs gives. */
function shotsDataDir(env = process.env) {
  return env.CREW_DATA_DIR || path.join(os.homedir(), '.roving-office', 'crew');
}

/** Never throws: a screenshot that cannot be deleted is not worth a job failing over. */
function forgetJobShots(jobId, { dataDir = shotsDataDir(), log = () => {} } = {}) {
  try {
    const { deleted } = createShots({ dataDir }).clearJob(jobId);
    if (deleted) log(`deleted ${deleted} screenshot${deleted === 1 ? '' : 's'} from job ${jobId}`);
    return deleted;
  } catch (err) {
    log(`could not delete the screenshots from job ${jobId}: ${err.message}`);
    return 0;
  }
}

/** At start: any job's screenshots left over, except kept ones and those of a job still running. */
function sweepOrphanShots({ dataDir = shotsDataDir(), isRunning = () => false, log = () => {} } = {}) {
  try {
    const { deleted } = createShots({ dataDir }).sweepJobs(isRunning);
    if (deleted) log(`deleted ${deleted} screenshot${deleted === 1 ? '' : 's'} left by jobs that had ended`);
    return deleted;
  } catch (err) {
    log(`could not sweep old screenshots: ${err.message}`);
    return 0;
  }
}

module.exports = { forgetJobShots, sweepOrphanShots, shotsDataDir };
