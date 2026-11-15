import clsx from "clsx";
import { CloudUpload } from "lucide-react";
import { clock, uploadShare, type UploadProgress } from "./data";
import { useNow } from "./ui";

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
const remaining = (seconds: number) =>
  seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left` : `about ${Math.round(seconds / 60)} min left`;

/** The glasses' video upload: a real progress bar when its bytes are counted, an estimate labeled as one when they can't be. */
export function UploadBar({ upload, snaps }: { upload: UploadProgress; snaps: number }) {
  const now = useNow(1000);
  const share = uploadShare(upload, now);
  // Past the estimate there is no honest percentage: the tunnel shows nothing until the end.
  const overdue = share?.overdue ?? false;
  const percent = share && !overdue ? Math.floor(share.fraction * 100) : null;
  return <div className="no-print rounded-2xl bg-sky-500/[0.07] px-4 py-3.5 ring-1 ring-sky-500/25 dark:bg-sky-400/[0.06] dark:ring-sky-400/25">
    <div className="flex items-center gap-2">
      <CloudUpload className="size-4 text-sky-600 dark:text-sky-300" strokeWidth={2.25} />
      <span className="text-sm font-semibold text-sky-800 dark:text-sky-200">Uploading the glasses’ video</span>
      {percent !== null && <span className="ml-auto text-lg font-semibold tabular-nums">{share?.estimated && "≈ "}{percent}%</span>}
    </div>
    <div role="progressbar" aria-label="Video upload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
      className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-sky-500/15 dark:bg-sky-400/15">
      {percent === null
        ? <div className="h-full w-1/3 rounded-full bg-sky-500 motion-safe:animate-[slide_1.4s_ease-in-out_infinite]" />
        : <div className={clsx("h-full rounded-full bg-sky-500 transition-[width] ease-linear", share?.estimated ? "duration-1000" : "duration-[3000ms]")} style={{ width: `${Math.max(2, percent)}%` }} />}
    </div>
    <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums text-slate-600 dark:text-slate-300">
      <span>{!share ? "Waiting for the glasses to start sending"
        : overdue ? `Still uploading after ${clock(share.elapsed)}, slower than the last upload`
        : `${share.estimated ? "≈ " : ""}${megabytes(share.sent)} of ${megabytes(share.total)}`}</span>
      {share && <span>{overdue ? `about ${megabytes(share.total)} in all` : share.left !== null ? remaining(share.left) : ""}</span>}
    </div>
    {share?.estimated && <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
      {overdue
        ? "The internet tunnel hands the video to Inbound only once all of it has arrived, so nothing shows until then. The phone stops waiting after 15 minutes; the video also stays in the Mentra gallery."
        : "Estimated from the last upload’s speed: the internet tunnel hands the video to Inbound only once it is complete."}
    </p>}
    {snaps > 0 && <p className="mt-1.5 text-xs font-medium leading-snug text-slate-600 dark:text-slate-300">
      {snaps === 1 ? "The snap photo" : `The ${snaps} snap photos`} taken during this video come out of it when it arrives.
    </p>}
  </div>;
}

/** The same upload on an incoming-board card. */
export function UploadMini({ upload }: { upload: UploadProgress }) {
  const now = useNow(1000);
  const share = uploadShare(upload, now);
  const percent = share && !share.overdue ? Math.floor(share.fraction * 100) : null;
  return <span className="inline-flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
    <CloudUpload className="size-3.5" />
    <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-sky-500/20">
      {percent === null
        ? <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-sky-500 motion-safe:animate-[slide_1.4s_ease-in-out_infinite]" />
        : <span className="absolute inset-y-0 left-0 rounded-full bg-sky-500 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.max(4, percent)}%` }} />}
    </span>
    <span className="font-semibold tabular-nums">{percent === null ? "Video" : `${share?.estimated ? "≈" : ""}${percent}%`}</span>
  </span>;
}
