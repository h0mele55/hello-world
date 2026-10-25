/**
 * The synthetic audit reports behind tests/fixtures/pdf/*.pdf. The client,
 * the firm and every figure are invented. `scripts/gen-pdf-fixtures.ts`
 * renders them, and the golden tests check that the opinion extracted from
 * each PDF is exactly the `opinion` paragraphs below.
 */
import type { Language, OpinionType } from '@/lib/opinion/types';

export interface ReportFixture {
  file: string;
  language: Language;
  /** The opinion the locator must find, or why it must find none. */
  expect: { type: OpinionType } | { notFound: 'NO_TEXT_LAYER' };
  /** Opinion paragraphs, rendered as written and expected back verbatim. */
  opinion: string[];
  /** Variant renderings. */
  render?: { scanned?: true; signed?: true; preambleParagraphs?: number };
  headings: { opinion: string; basis: string };
  basis: string[];
}

const EN_CLIENT = 'Example Manufacturing AD';
const BG_CLIENT = '„Пример Производство“ АД';

const EN_SCOPE = `We have audited the financial statements of ${EN_CLIENT} (the Company), which comprise the statement of financial position as at 31 December 2025, and the statement of profit or loss and other comprehensive income, statement of changes in equity and statement of cash flows for the year then ended, and notes to the financial statements, including material accounting policy information.`;
const EN_BASIS = `We conducted our audit in accordance with International Standards on Auditing (ISAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the Company in accordance with the International Ethics Standards Board for Accountants' International Code of Ethics for Professional Accountants, and we have fulfilled our other ethical responsibilities in accordance with these requirements.`;

const BG_SCOPE = `Ние извършихме одит на финансовия отчет на ${BG_CLIENT} („Дружеството“), съдържащ отчета за финансовото състояние към 31 декември 2025 г. и отчета за печалбата или загубата и другия всеобхватен доход, отчета за промените в собствения капитал и отчета за паричните потоци за годината, завършваща на тази дата, както и пояснителните приложения към финансовия отчет, включително съществена информация относно счетоводната политика.`;
const BG_BASIS = `Ние извършихме нашия одит в съответствие с Международните одиторски стандарти (МОС). Нашите отговорности съгласно тези стандарти са описани допълнително в раздела от нашия доклад „Отговорности на одитора за одита на финансовия отчет“. Ние сме независими от Дружеството в съответствие с Международния етичен кодекс на професионалните счетоводители.`;

export const REPORTS: ReportFixture[] = [
  {
    file: 'en-unmodified.pdf',
    language: 'en',
    expect: { type: 'UNMODIFIED' },
    headings: { opinion: 'Opinion', basis: 'Basis for Opinion' },
    opinion: [
      EN_SCOPE,
      'In our opinion, the accompanying financial statements present fairly, in all material respects, the financial position of the Company as at 31 December 2025, and its financial performance and its cash flows for the year then ended in accordance with IFRS Accounting Standards as adopted by the European Union.',
    ],
    basis: [EN_BASIS],
  },
  {
    file: 'en-qualified.pdf',
    language: 'en',
    expect: { type: 'QUALIFIED' },
    // Pushes the opinion across the page break; see bg-qualified.
    render: { preambleParagraphs: 18 },
    headings: { opinion: 'Qualified Opinion', basis: 'Basis for Qualified Opinion' },
    opinion: [
      EN_SCOPE,
      'In our opinion, except for the effects of the matter described in the Basis for Qualified Opinion section of our report, the accompanying financial statements present fairly, in all material respects, the financial position of the Company as at 31 December 2025, and its financial performance and its cash flows for the year then ended in accordance with IFRS Accounting Standards as adopted by the European Union.',
    ],
    basis: [
      "The Company's inventories are carried in the statement of financial position at BGN 4,215 thousand. Management has not stated the inventories at the lower of cost and net realisable value but has stated them solely at cost, which constitutes a departure from IAS 2 Inventories.",
      EN_BASIS,
    ],
  },
  {
    file: 'en-adverse.pdf',
    language: 'en',
    expect: { type: 'ADVERSE' },
    headings: { opinion: 'Adverse Opinion', basis: 'Basis for Adverse Opinion' },
    opinion: [
      EN_SCOPE,
      'In our opinion, because of the significance of the matter discussed in the Basis for Adverse Opinion section of our report, the accompanying financial statements do not present fairly the financial position of the Company as at 31 December 2025, and its financial performance and its cash flows for the year then ended in accordance with IFRS Accounting Standards as adopted by the European Union.',
    ],
    basis: [
      'As explained in Note 4, the Company has not consolidated its subsidiary Example Logistics EOOD, which it acquired during 2025, because it has not yet been able to determine the fair values of certain of the subsidiary’s material assets and liabilities at the acquisition date.',
      EN_BASIS,
    ],
  },
  {
    file: 'en-disclaimer.pdf',
    language: 'en',
    expect: { type: 'DISCLAIMER' },
    headings: { opinion: 'Disclaimer of Opinion', basis: 'Basis for Disclaimer of Opinion' },
    opinion: [
      `We were engaged to audit the financial statements of ${EN_CLIENT} (the Company), which comprise the statement of financial position as at 31 December 2025, and the statement of profit or loss and other comprehensive income, statement of changes in equity and statement of cash flows for the year then ended, and notes to the financial statements, including material accounting policy information.`,
      'We do not express an opinion on the accompanying financial statements of the Company. Because of the significance of the matter described in the Basis for Disclaimer of Opinion section of our report, we have not been able to obtain sufficient appropriate audit evidence to provide a basis for an audit opinion on these financial statements.',
    ],
    basis: [
      "We were appointed as auditors of the Company on 15 January 2026 and thus did not observe the counting of physical inventories at the beginning or the end of the year. We were unable to satisfy ourselves by alternative means concerning inventory quantities held at 31 December 2025, which are stated in the statement of financial position at BGN 4,215 thousand.",
    ],
  },
  {
    file: 'bg-unmodified.pdf',
    language: 'bg',
    expect: { type: 'UNMODIFIED' },
    headings: { opinion: 'Мнение', basis: 'База за изразяване на мнение' },
    opinion: [
      BG_SCOPE,
      'По наше мнение, приложеният финансов отчет дава вярна и честна представа за финансовото състояние на Дружеството към 31 декември 2025 г. и за неговите финансови резултати от дейността и паричните му потоци за годината, завършваща на тази дата, в съответствие с МСФО счетоводни стандарти, приети от Европейския съюз.',
    ],
    basis: [BG_BASIS],
  },
  {
    file: 'bg-qualified.pdf',
    language: 'bg',
    expect: { type: 'QUALIFIED' },
    // A long preamble pushes the opinion across the page break, so the running
    // header and footer land inside it and must be removed.
    render: { preambleParagraphs: 15 },
    headings: { opinion: 'Квалифицирано мнение', basis: 'База за изразяване на квалифицирано мнение' },
    opinion: [
      BG_SCOPE,
      'По наше мнение, с изключение на ефекта от въпроса, описан в раздела от нашия доклад „База за изразяване на квалифицирано мнение“, приложеният финансов отчет дава вярна и честна представа за финансовото състояние на Дружеството към 31 декември 2025 г. и за неговите финансови резултати от дейността и паричните му потоци за годината, завършваща на тази дата, в съответствие с МСФО счетоводни стандарти, приети от Европейския съюз.',
    ],
    basis: [
      'Материалните запаси на Дружеството са представени в отчета за финансовото състояние в размер на 4 215 хил. лв. Ръководството не е оценило материалните запаси по по-ниската от себестойността и нетната реализуема стойност, а само по себестойност, което представлява отклонение от МСС 2 „Материални запаси“.',
      BG_BASIS,
    ],
  },
  {
    file: 'bg-adverse.pdf',
    language: 'bg',
    expect: { type: 'ADVERSE' },
    headings: { opinion: 'Отрицателно мнение', basis: 'База за изразяване на отрицателно мнение' },
    opinion: [
      BG_SCOPE,
      'По наше мнение, поради значимостта на въпроса, разгледан в раздела от нашия доклад „База за изразяване на отрицателно мнение“, приложеният финансов отчет не дава вярна и честна представа за финансовото състояние на Дружеството към 31 декември 2025 г. и за неговите финансови резултати от дейността и паричните му потоци за годината, завършваща на тази дата.',
    ],
    basis: [
      'Както е посочено в Приложение 4, Дружеството не е консолидирало дъщерното си дружество „Пример Логистика“ ЕООД, придобито през 2025 г., тъй като все още не е определило справедливите стойности на някои от съществените му активи и пасиви към датата на придобиване.',
      BG_BASIS,
    ],
  },
  {
    file: 'bg-disclaimer.pdf',
    language: 'bg',
    expect: { type: 'DISCLAIMER' },
    headings: { opinion: 'Отказ от изразяване на мнение', basis: 'База за отказ от изразяване на мнение' },
    opinion: [
      `Ние бяхме ангажирани да извършим одит на финансовия отчет на ${BG_CLIENT} („Дружеството“), съдържащ отчета за финансовото състояние към 31 декември 2025 г. и отчета за печалбата или загубата и другия всеобхватен доход, отчета за промените в собствения капитал и отчета за паричните потоци за годината, завършваща на тази дата.`,
      'Ние не изразяваме мнение относно приложения финансов отчет на Дружеството. Поради значимостта на въпроса, описан в раздела от нашия доклад „База за отказ от изразяване на мнение“, ние не успяхме да получим достатъчни и уместни одиторски доказателства, които да осигурят база за изразяване на одиторско мнение относно този финансов отчет.',
    ],
    basis: [
      'Ние бяхме назначени за одитори на Дружеството на 15 януари 2026 г. и поради това не наблюдавахме инвентаризацията на материалните запаси в началото и в края на годината. Не успяхме да се убедим чрез алтернативни процедури в наличните количества към 31 декември 2025 г.',
    ],
  },
  {
    file: 'en-scanned.pdf',
    language: 'en',
    expect: { notFound: 'NO_TEXT_LAYER' },
    render: { scanned: true },
    headings: { opinion: 'Opinion', basis: 'Basis for Opinion' },
    opinion: [],
    basis: [],
  },
  {
    file: 'en-signed.pdf',
    language: 'en',
    expect: { type: 'UNMODIFIED' },
    render: { signed: true },
    headings: { opinion: 'Opinion', basis: 'Basis for Opinion' },
    opinion: [
      EN_SCOPE,
      'In our opinion, the accompanying financial statements present fairly, in all material respects, the financial position of the Company as at 31 December 2025, and its financial performance and its cash flows for the year then ended in accordance with IFRS Accounting Standards as adopted by the European Union.',
    ],
    basis: [EN_BASIS],
  },
];

export const TRAILING_SECTIONS: Record<Language, { heading: string; text: string }[]> = {
  en: [
    {
      heading: 'Responsibilities of Management for the Financial Statements',
      text: 'Management is responsible for the preparation and fair presentation of the financial statements in accordance with IFRS Accounting Standards as adopted by the European Union, and for such internal control as management determines is necessary to enable the preparation of financial statements that are free from material misstatement, whether due to fraud or error.',
    },
    {
      heading: "Auditor's Responsibilities for the Audit of the Financial Statements",
      text: 'Our objectives are to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatement, whether due to fraud or error, and to issue an auditor’s report that includes our opinion. Reasonable assurance is a high level of assurance, but is not a guarantee that an audit conducted in accordance with ISAs will always detect a material misstatement when it exists.',
    },
  ],
  bg: [
    {
      heading: 'Отговорности на ръководството за финансовия отчет',
      text: 'Ръководството носи отговорност за изготвянето и достоверното представяне на този финансов отчет в съответствие с МСФО счетоводни стандарти, приети от Европейския съюз, и за такава система за вътрешен контрол, каквато ръководството определя като необходима за изготвянето на финансови отчети, които не съдържат съществени неправилни отчитания, независимо дали дължащи се на измама или грешка.',
    },
    {
      heading: 'Отговорности на одитора за одита на финансовия отчет',
      text: 'Нашите цели са да получим разумна степен на сигурност относно това дали финансовият отчет като цяло не съдържа съществени неправилни отчитания, независимо дали дължащи се на измама или грешка, и да издадем одиторски доклад, който да включва нашето одиторско мнение.',
    },
  ],
};

export const LABELS: Record<Language, { title: string; addressee: string; section: string; header: string; page: (n: number, total: number) => string; preamble: string }> = {
  en: {
    title: "INDEPENDENT AUDITOR'S REPORT",
    addressee: `To the shareholders of ${EN_CLIENT}`,
    section: 'Report on the Audit of the Financial Statements',
    header: `${EN_CLIENT} · Independent auditor's report · 31 December 2025`,
    page: (n, total) => `Page ${n} of ${total}`,
    preamble: 'This paragraph is filler that moves the opinion further down the page, as a cover letter or table of contents would in a real report.',
  },
  bg: {
    title: 'ДОКЛАД НА НЕЗАВИСИМИЯ ОДИТОР',
    addressee: `До акционерите на ${BG_CLIENT}`,
    section: 'Доклад относно одита на финансовия отчет',
    header: `${BG_CLIENT} · Доклад на независимия одитор · 31 декември 2025 г.`,
    page: (n, total) => `Страница ${n} от ${total}`,
    preamble: 'Този абзац е запълващ текст, който премества мнението по-надолу на страницата, както би го направило придружително писмо или съдържание в реален доклад.',
  },
};
