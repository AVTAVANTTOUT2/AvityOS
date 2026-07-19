import { useMemo, useState } from "react";
import type { ApiClarification, ApiClarificationQuestion } from "../../lib/api";
import { ApiRequestError } from "../../lib/api";
import { cn, Glass } from "./shared";

interface ClarificationPanelProps {
  clarification: ApiClarification | null;
  busy?: boolean;
  onSubmit: (answers: { questionId: string; answer?: string; value?: unknown }[]) => Promise<void>;
}

function sortQuestions(questions: ApiClarificationQuestion[]): ApiClarificationQuestion[] {
  return [...questions].sort((a, b) => a.displayOrder - b.displayOrder);
}

export function ClarificationPanel({ clarification, busy = false, onSubmit }: ClarificationPanelProps) {
  const questions = useMemo(
    () => (clarification ? sortQuestions(clarification.questions) : []),
    [clarification],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!clarification) {
    return (
      <Glass className="p-4">
        <div className="text-[11px] text-[#74716B]">Aucune clarification ouverte pour ce projet.</div>
      </Glass>
    );
  }

  const provenanceLabel =
    clarification.provenance === "fake_fixture"
      ? "Fixture déterministe (fake_fixture)"
      : clarification.provenance === "deterministic_policy"
        ? "Politique déterministe (non-IA)"
        : "IA structurée";

  async function handleSubmit(): Promise<void> {
    if (submitting || busy) return;
    setError(null);
    const answers: { questionId: string; answer?: string; value?: unknown }[] = [];
    for (const question of questions) {
      if (question.answerType === "multi_choice") {
        const selected = multi[question.id] ?? [];
        if (question.required && selected.length === 0) {
          setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
          return;
        }
        if (selected.length > 0) {
          answers.push({ questionId: question.id, value: { type: "multi_choice", value: selected } });
        }
        continue;
      }
      if (question.answerType === "boolean") {
        const raw = values[question.id];
        if (question.required && (raw === undefined || raw === "")) {
          setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
          return;
        }
        if (raw !== undefined && raw !== "") {
          answers.push({ questionId: question.id, value: { type: "boolean", value: raw === "true" } });
        }
        continue;
      }
      if (question.answerType === "single_choice") {
        const raw = values[question.id];
        if (question.required && !raw) {
          setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
          return;
        }
        if (raw) answers.push({ questionId: question.id, value: { type: "single_choice", value: raw } });
        continue;
      }
      if (question.answerType === "number" || question.answerType === "budget") {
        const raw = values[question.id];
        if (question.required && (raw === undefined || raw === "")) {
          setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
          return;
        }
        if (raw !== undefined && raw !== "") {
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            setError(`Nombre invalide pour ${question.logicalKey}`);
            return;
          }
          answers.push({
            questionId: question.id,
            value: { type: question.answerType, value: n },
          });
        }
        continue;
      }
      if (question.answerType === "path_scope") {
        const raw = values[question.id] ?? "";
        const paths = raw.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
        if (question.required && paths.length === 0) {
          setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
          return;
        }
        if (paths.length > 0) {
          answers.push({ questionId: question.id, value: { type: "path_scope", value: paths } });
        }
        continue;
      }
      const raw = (values[question.id] ?? "").trim();
      if (question.required && !raw) {
        setError(`Réponse obligatoire manquante : ${question.logicalKey}`);
        return;
      }
      if (raw) answers.push({ questionId: question.id, answer: raw });
    }

    setSubmitting(true);
    try {
      await onSubmit(answers);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : String(err);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Glass className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[#202124]">Clarifications groupées</div>
          <div className="text-[11px] text-[#74716B] mt-1">
            Tour {clarification.round} · {questions.length} question(s) · répondez en une seule soumission
          </div>
        </div>
        <span
          className={cn(
            "text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
            clarification.provenance === "fake_fixture"
              ? "bg-amber-50 text-amber-700"
              : clarification.provenance === "deterministic_policy"
                ? "bg-slate-100 text-slate-700"
                : "bg-blue-50 text-[#5267D9]",
          )}
        >
          {provenanceLabel}
        </span>
      </div>

      <div className="space-y-4">
        {questions.map((question) => (
          <div key={question.id} className="border-t border-black/[0.05] pt-3 first:border-0 first:pt-0">
            <div className="text-[11px] font-medium text-[#202124]">{question.question}</div>
            <div className="text-[10px] text-[#74716B] mt-1">{question.reason}</div>
            <div className="mt-2">
              {question.answerType === "boolean" ? (
                <div className="flex gap-2">
                  {["true", "false"].map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={submitting || busy}
                      onClick={() => setValues((prev) => ({ ...prev, [question.id]: option }))}
                      className={cn(
                        "px-3 py-1.5 rounded-xl text-[11px] border",
                        values[question.id] === option
                          ? "border-[#5267D9]/40 bg-[#5267D9]/[0.06]"
                          : "border-black/10 bg-[#F7F4EE]",
                      )}
                    >
                      {option === "true" ? "Oui" : "Non"}
                    </button>
                  ))}
                </div>
              ) : question.answerType === "single_choice" ? (
                <div className="space-y-1.5">
                  {question.options.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      disabled={submitting || busy}
                      onClick={() => setValues((prev) => ({ ...prev, [question.id]: option.key }))}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-xl text-[11px] border",
                        values[question.id] === option.key
                          ? "border-[#5267D9]/40 bg-[#5267D9]/[0.06]"
                          : "border-black/10 bg-[#F7F4EE]",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : question.answerType === "multi_choice" ? (
                <div className="space-y-1.5">
                  {question.options.map((option) => {
                    const selected = (multi[question.id] ?? []).includes(option.key);
                    return (
                      <button
                        key={option.key}
                        type="button"
                        disabled={submitting || busy}
                        onClick={() =>
                          setMulti((prev) => {
                            const current = new Set(prev[question.id] ?? []);
                            if (current.has(option.key)) current.delete(option.key);
                            else current.add(option.key);
                            return { ...prev, [question.id]: [...current] };
                          })
                        }
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-xl text-[11px] border",
                          selected ? "border-[#5267D9]/40 bg-[#5267D9]/[0.06]" : "border-black/10 bg-[#F7F4EE]",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  disabled={submitting || busy}
                  value={values[question.id] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                  rows={question.answerType === "path_scope" ? 3 : 2}
                  placeholder={
                    question.answerType === "path_scope"
                      ? "Un chemin relatif par ligne"
                      : question.required
                        ? "Réponse obligatoire"
                        : "Réponse facultative"
                  }
                  className="w-full text-[11px] rounded-xl border border-black/10 bg-white px-3 py-2 outline-none focus:border-[#5267D9]/40"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="text-[11px] text-red-600">{error}</div>}
      <button
        type="button"
        disabled={submitting || busy}
        onClick={() => void handleSubmit()}
        className="text-[11px] bg-[#202124] text-white px-4 py-2 rounded-xl disabled:opacity-40"
      >
        {submitting ? "Envoi…" : "Envoyer toutes les réponses"}
      </button>
    </Glass>
  );
}
