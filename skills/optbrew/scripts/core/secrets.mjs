/** Secret and private-identifier shapes that must never reach a report packet, stored evidence, or a model-judgment queue. */
export const sensitive = /(?:sk-ant-api03-[A-Za-z0-9_-]{32,}|sk-proj-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|\b\d{6}-[1-8]\d{6}\b)/;
