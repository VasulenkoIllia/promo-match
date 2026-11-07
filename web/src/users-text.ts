// The words of the «Користувачі» screen (UsersView.tsx) and of the pages of its one-time links (LinkView.tsx), kept
// beside text.ts, whose rules they follow
import type { ApiFailure, Role } from "./api";
import { type ErrorText, formatNumber, searchErrorText } from "./text";
import type { LinkKind } from "./users-api";

const ROLE_NAMES: Record<Role, string> = { admin: "Адміністратор", manager: "Менеджер" };
const SECONDS_IN_MINUTE = 60;
const moments = new Intl.DateTimeFormat("uk-UA", { dateStyle: "short", timeStyle: "short" });
const days = new Intl.DateTimeFormat("uk-UA", { dateStyle: "short" });

export function roleName(role: Role): string {
  return ROLE_NAMES[role];
}

// An ISO time from the server; one it cannot read is shown as it is
function dateText(iso: string, format: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
}

export function momentText(iso: string): string {
  return dateText(iso, moments);
}

export function dayText(iso: string): string {
  return dateText(iso, days);
}

export function defaultStatusText(status: number): string {
  return `Сервер відповів помилкою ${status}. Спробуйте ще раз.`;
}

// The failures that do not depend on the request read the same as the search's
export function statusErrorText(failure: ApiFailure, statusText: (status: number) => string): ErrorText {
  if (failure.kind !== "status" || (failure.detail === null && failure.status >= 500)) return searchErrorText(failure);
  return { message: statusText(failure.status), detail: failure.detail };
}

export function usersErrorText(failure: ApiFailure): ErrorText {
  return statusErrorText(failure, (status) => {
    switch (status) {
      case 403:
        return "Цей розділ лише для адміністратора. Оновіть сторінку.";
      case 404:
        return "Не знайшов цього користувача. Оновіть перелік.";
      case 409:
        return "Свій обліковий запис вимкнути не можна.";
      default:
        return defaultStatusText(status);
    }
  });
}

export function linkErrorText(failure: ApiFailure): ErrorText {
  if (failure.kind === "limited") {
    const minutes = Math.ceil(failure.retryAfterSeconds / SECONDS_IN_MINUTE);
    return { message: `Забагато спроб. Спробуйте за ${formatNumber(minutes)} хв.`, detail: null };
  }
  return statusErrorText(failure, (status) => {
    switch (status) {
      case 400:
        return "Не прийнято: перевірте логін і пароль за підказками біля полів.";
      case 403:
        return "Сервер не прийняв запит із цієї сторінки. Відкрийте посилання ще раз.";
      case 409:
        return "Такий логін уже є. Оберіть інший.";
      case 410:
        return "Посилання вже використане, його строк минув чи воно недійсне. Попросіть адміністратора про нове.";
      default:
        return defaultStatusText(status);
    }
  });
}

export const usersText = {
  heading: "Користувачі",
  newHeading: "Нове запрошення",
  role: "Роль",
  roleHint: "Адміністратор запрошує людей і керує входом. Менеджер шукає, оцінює й прив'язує свої товари.",
  createInvite: "Створити посилання",
  creating: "Створюю...",
  inviteHeading: (role: Role) => `Запрошення, роль: ${roleName(role).toLowerCase()}`,
  resetHeading: (login: string) => `Новий пароль для ${login}`,
  linkLabel: "Посилання",
  linkHint: (expiresAt: string) => `Посилання одноразове й діє до ${momentText(expiresAt)}. Надішліть його людині самі, наприклад у месенджері. Я його більше не покажу.`,
  copy: "Копіювати",
  copied: "Скопійовано.",
  copyFailed: "Не вдалося скопіювати. Виділіть посилання й скопіюйте вручну.",
  loading: "Завантажую користувачів...",
  retry: "Спробувати ще раз",
  incomplete: "Показано не всіх: користувачів більше, ніж вміщує перелік.",
  columns: { login: "Логін", role: "Роль", state: "Стан", created: "Створено", actions: "Дії" },
  active: "Активний",
  disabled: "Вимкнений",
  you: "це ви",
  disable: "Вимкнути",
  enable: "Увімкнути",
  reset: "Скинути пароль",
  disableUser: (login: string) => `Вимкнути ${login}`,
  enableUser: (login: string) => `Увімкнути ${login}`,
  resetUser: (login: string) => `Скинути пароль для ${login}`,
  resetHint: "Скидання дає посилання на новий пароль. Поки людина ним не скористалась, старий пароль діє.",
};

export const linkText = {
  heading: { invite: "Вхід за запрошенням", reset: "Новий пароль" } satisfies Record<LinkKind, string>,
  login: "Логін",
  loginHint: "Малі латинські літери, цифри, крапка, дефіс чи підкреслення, від 2 до 64 знаків, на початку літера чи цифра.",
  password: "Пароль",
  passwordHint: "Від 12 до 128 знаків.",
  again: "Пароль ще раз",
  differ: "Паролі різні.",
  tooShort: "Пароль коротший за 12 знаків.",
  submit: { invite: "Створити обліковий запис", reset: "Зберегти пароль" } satisfies Record<LinkKind, string>,
  pending: "Зберігаю...",
  done: {
    invite: (login: string) => `Обліковий запис ${login} створено. Увійдіть з цим логіном і паролем.`,
    reset: (login: string) => `Пароль для ${login} змінено, усі попередні входи закрито. Увійдіть з новим паролем.`,
  } satisfies Record<LinkKind, (login: string) => string>,
  toLogin: "Перейти до входу",
  noToken: "Посилання неповне чи вже відкривалось на цій сторінці. Відкрийте його ще раз з повідомлення.",
};
