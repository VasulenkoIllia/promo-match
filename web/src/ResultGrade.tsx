import { useState } from "react";
import type { Grade } from "./api";
import { text } from "./text";

const GRADES: Grade[] = ["exact", "suitable", "wrong"];

interface ResultGradeProps {
  // For the group's accessible name: the cards show up to 100 of these
  modelName: string;
  grade: Grade | null;
  // Rejects when the grade was not saved: it then stays as it was, and the card says so
  onChange: (grade: Grade | null) => Promise<void>;
}

export function ResultGrade({ modelName, grade, onChange }: ResultGradeProps) {
  const [isPending, setIsPending] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  const pick = async (picked: Grade) => {
    setIsPending(true);
    setHasFailed(false);
    try {
      // The grade picked again is taken back: a click by mistake leaves nothing behind
      await onChange(picked === grade ? null : picked);
    } catch (error) {
      console.error(error);
      setHasFailed(true);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="card-grade" role="group" aria-label={text.grades.label(modelName)}>
      {GRADES.map((each) => (
        <button
          key={each}
          type="button"
          className={each === grade ? `is-${each}` : undefined}
          aria-pressed={each === grade}
          disabled={isPending}
          onClick={() => void pick(each)}
        >
          {text.grades.names[each]}
        </button>
      ))}
      {hasFailed && <p className="error-text" role="alert">{text.grades.failed}</p>}
    </div>
  );
}
