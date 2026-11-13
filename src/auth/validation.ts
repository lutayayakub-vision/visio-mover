// Client-side validation is for user feedback only. Supabase enforces the real rules on the server.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const isValidEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);

/** Strip control characters and angle brackets, collapse whitespace, cap length. */
export const cleanName = (v: string) =>
  v.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

export type PasswordCheck = {
  rules: { label: string; ok: boolean }[];
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too weak" | "Weak" | "Fair" | "Good" | "Strong";
  valid: boolean;
};

const COMMON = ["password", "123456", "qwerty", "letmein", "welcome", "iloveyou", "admin", "visiomover"];

export function checkPassword(pw: string): PasswordCheck {
  const rules = [
    { label: "At least 10 characters", ok: pw.length >= 10 },
    { label: "An uppercase letter", ok: /[A-Z]/.test(pw) },
    { label: "A lowercase letter", ok: /[a-z]/.test(pw) },
    { label: "A number", ok: /\d/.test(pw) },
    { label: "A symbol", ok: /[^A-Za-z0-9]/.test(pw) },
  ];
  const common = COMMON.some((c) => pw.toLowerCase().includes(c));
  const passed = rules.filter((r) => r.ok).length;
  let score = Math.max(0, passed - 1) as 0 | 1 | 2 | 3 | 4;
  if (pw.length >= 14 && passed === 5) score = 4;
  if (common) score = Math.min(score, 1) as 0 | 1 | 2 | 3 | 4;
  const labels = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;
  return { rules, score, label: labels[score], valid: passed === 5 && !common };
}
