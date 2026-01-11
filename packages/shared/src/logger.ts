import pino from "pino";

export function createLogger(service: string, opts?: { toStderr?: boolean }) {
  const level = process.env.LOG_LEVEL || "info";
  const useStderr = opts?.toStderr || process.env.LOG_STDERR === "true";
  const destination = useStderr ? pino.destination(2) : undefined;
  return pino({ level, base: { service } }, destination);
}
