import sys, os
from PIL import Image as PILImage
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
                                Image, PageBreak, NextPageTemplate, KeepTogether, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents

SHOTS, OUT = sys.argv[1], sys.argv[2]
F = '/usr/share/fonts/truetype/dejavu/'
pdfmetrics.registerFont(TTFont('DV', F + 'DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DVB', F + 'DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('DVI', '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf'))
pdfmetrics.registerFont(TTFont('DVM', F + 'DejaVuSansMono.ttf'))
from reportlab.lib.fonts import addMapping
addMapping('DV', 0, 0, 'DV'); addMapping('DV', 1, 0, 'DVB'); addMapping('DV', 0, 1, 'DVI'); addMapping('DV', 1, 1, 'DVB')

RED = colors.HexColor('#C0392B')
DARK = colors.HexColor('#222222')
MUTED = colors.HexColor('#595959')
LIGHT = colors.HexColor('#F6F6F6')
LINE = colors.HexColor('#D0D0D0')

S = {
    'body': ParagraphStyle('body', fontName='DV', fontSize=9.5, leading=14, textColor=DARK, spaceAfter=6),
    'h1': ParagraphStyle('h1', fontName='DVB', fontSize=17, leading=22, textColor=RED, spaceBefore=4, spaceAfter=10),
    'h2': ParagraphStyle('h2', fontName='DVB', fontSize=12.5, leading=17, textColor=DARK, spaceBefore=12, spaceAfter=6),
    'h3': ParagraphStyle('h3', fontName='DVB', fontSize=10.5, leading=14, textColor=RED, spaceBefore=8, spaceAfter=4),
    'cell': ParagraphStyle('cell', fontName='DV', fontSize=8.3, leading=11, textColor=DARK),
    'cellb': ParagraphStyle('cellb', fontName='DVB', fontSize=8.3, leading=11, textColor=colors.white),
    'cap': ParagraphStyle('cap', fontName='DVI', fontSize=8, leading=11, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10),
    'bullet': ParagraphStyle('bullet', fontName='DV', fontSize=9.5, leading=14, textColor=DARK, leftIndent=14, bulletIndent=3, spaceAfter=3),
    'formula': ParagraphStyle('formula', fontName='DVM', fontSize=9, leading=13, textColor=DARK, backColor=LIGHT,
                              borderPadding=(6, 8, 6, 8), leftIndent=8, rightIndent=8, spaceBefore=6, spaceAfter=12),
    'note': ParagraphStyle('note', fontName='DV', fontSize=9, leading=13, textColor=DARK, backColor=colors.HexColor('#FDF2E9'),
                           borderColor=colors.HexColor('#E67E22'), borderWidth=0, borderPadding=(6, 8, 6, 8),
                           leftIndent=8, rightIndent=8, spaceBefore=6, spaceAfter=12),
    'title': ParagraphStyle('title', fontName='DVB', fontSize=30, leading=36, textColor=DARK),
    'sub': ParagraphStyle('sub', fontName='DV', fontSize=13, leading=18, textColor=MUTED),
    'toc1': ParagraphStyle('toc1', fontName='DVB', fontSize=10.5, leading=16, leftIndent=0),
    'toc2': ParagraphStyle('toc2', fontName='DV', fontSize=9.5, leading=14, leftIndent=16),
}


class Doc(BaseDocTemplate):
    def __init__(self, fn):
        super().__init__(fn, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm,
                         title='Project Budget Calculator – User Guide', author='Project Budget Calculator')
        pw, ph = A4
        port = Frame(2 * cm, 2 * cm, pw - 4 * cm, ph - 4 * cm, id='p')
        lw, lh = landscape(A4)
        land = Frame(1.5 * cm, 1.6 * cm, lw - 3 * cm, lh - 3.2 * cm, id='l')
        self.addPageTemplates([
            PageTemplate('cover', [port], onPage=lambda c, d: None, pagesize=A4),
            PageTemplate('port', [port], onPage=self.deco, pagesize=A4),
            PageTemplate('land', [land], onPage=self.deco, pagesize=landscape(A4)),
        ])

    def deco(self, c, d):
        w, h = c._pagesize
        c.saveState()
        c.setStrokeColor(RED); c.setLineWidth(1.2)
        c.line(d.leftMargin if w < h else 1.5 * cm, h - 1.3 * cm, w - (2 * cm if w < h else 1.5 * cm), h - 1.3 * cm)
        c.setFont('DV', 7.5); c.setFillColor(MUTED)
        c.drawString(2 * cm if w < h else 1.5 * cm, h - 1.15 * cm, 'Project Budget Calculator — User Guide')
        c.drawRightString(w - (2 * cm if w < h else 1.5 * cm), 0.9 * cm, f'Page {d.page}')
        c.restoreState()

    def afterFlowable(self, f):
        if isinstance(f, Paragraph) and f.style.name in ('h1', 'h2'):
            lvl = 0 if f.style.name == 'h1' else 1
            key = f'k{id(f)}'
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(f.getPlainText(), key, level=lvl, closed=False)
            self.notify('TOCEntry', (lvl, f.getPlainText(), self.page, key))


P = lambda t, s='body': Paragraph(t, S[s])
H1 = lambda t: Paragraph(t, S['h1'])
H2 = lambda t: Paragraph(t, S['h2'])
H3 = lambda t: Paragraph(t, S['h3'])


def bullets(items):
    return [Paragraph(i, S['bullet'], bulletText='•') for i in items]


def steps(items):
    return [Paragraph(i, S['bullet'], bulletText=f'{n}.') for n, i in enumerate(items, 1)]


def table(rows, widths, header=True, zebra=True):
    data = []
    for i, r in enumerate(rows):
        data.append([Paragraph(str(c), S['cellb'] if (header and i == 0) else S['cell']) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    st = [('GRID', (0, 0), (-1, -1), 0.4, LINE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
          ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5)]
    if header:
        st.append(('BACKGROUND', (0, 0), (-1, 0), RED))
    if zebra:
        for i in range(1 if header else 0, len(rows)):
            if i % 2 == 0:
                st.append(('BACKGROUND', (0, i), (-1, i), LIGHT))
    t.setStyle(TableStyle(st))
    return t


def img(key, width, caption=None, maxh=None):
    p = os.path.join(SHOTS, key + '.png')
    w, h = PILImage.open(p).size
    hh = width * h / w
    if maxh and hh > maxh:
        hh, width = maxh, maxh * w / h
    out = [Image(p, width=width, height=hh)]
    if caption:
        out.append(P(caption, 'cap'))
    return KeepTogether(out)


PW = A4[0] - 4 * cm
LW = landscape(A4)[0] - 3 * cm


def land_fig(key, caption, title=None):
    out = [NextPageTemplate('land'), PageBreak()]
    if title:
        out.append(P(title, 'h3'))
    out += [img(key, LW, caption, maxh=15.5 * cm), NextPageTemplate('port'), PageBreak()]
    return out


def land_fig2(k1, c1, k2, c2, title):
    """Two halves of a wide sheet on one landscape page."""
    return [NextPageTemplate('land'), PageBreak(), P(title, 'h3'),
            img(k1, LW, c1, maxh=7 * cm), img(k2, LW, c2, maxh=7 * cm),
            NextPageTemplate('port'), PageBreak()]


def port_fig(key, caption, title):
    """A tall sheet on its own portrait page."""
    return [PageBreak(), P(title, 'h3'), img(key, PW, caption, maxh=22.5 * cm), PageBreak()]


def figs(title, items):
    """Screenshots at full portrait width, flowing onto as many pages as needed."""
    out = [CondPageBreak(8 * cm), P(title, 'h3')]
    for k, c in items:
        out.append(img(k, PW, c, maxh=10.5 * cm))
    return out


FIGS_projects = figs('4.2 Projects: screenshots', [('projects1', 'Figure 2a: Projects, input columns A–G, with the settings at the top and the totals row.'), ('projects2', 'Figure 2b: Projects, calculated columns H–N. Analytics Pilot is flagged because its WIP (10,500) is above its contract (9,000).')])
FIGS_phasing1 = figs('4.3 Phasing: screenshots', [('phasing0', 'Figure 3a: Phasing helper columns A–H.'), ('phasing1', 'Figure 3b: Raw weights M1–M12 (input).'), ('phasing2', 'Figure 3c: Raw weights M13–M24 (input).'), ('phasing3', 'Figure 3d: Normalised weights M1–M12 (columns AH–AS).'), ('phasing4', 'Figure 3e: Normalised weights M13–M24 and the Σ check (columns AT–BF).')])
FIGS_wiplog1 = figs('4.4 WIP Log: screenshots', [('wiplog1', 'Figure 4a: WIP Log, 2026, with the totals row. Light-yellow cells are the active window up to the Current Month (Oct 2026).'), ('wiplog2', 'Figure 4b: WIP Log, 2027 (all "future" at this Current Month).'), ('wiplog3', 'Figure 4c: WIP Log, 2028.')])
FIGS_timeline1 = figs('4.6 Timeline: screenshots', [('timeline1', 'Figure 7a: Timeline, 2026. CRM Rollout is complete (all actual). The red-bordered column is the Current Month.'), ('timeline2', 'Figure 7b: Timeline, 2027. Security Audit is phased 1:2:2:1 over Mar–Jun 2027.'), ('timeline3', 'Figure 7c: Timeline, 2028 (empty for these sample projects, which all end by Jun 2027).')])
FIGS_aggannual = figs('4.7 Aggregator: annual totals and chart', [('aggannual', 'Figure 9: Annual totals, reconciliation (fully phased) and portfolio chart.')])
FIGS_phased1 = figs('4.8 Phased Budget: screenshots', [('phased0', 'Figure 10a: Phased Budget helper columns A–G.'), ('phased1', 'Figure 10b: Phased Budget, 2026, with the totals row. Values appear only after Oct 2026, the Current Month.'), ('phased2', 'Figure 10c: Phased Budget, 2027.'), ('phased3', 'Figure 10d: Phased Budget, 2028.')])


story = []
# ------------------------------------------------------------------ cover
story += [Spacer(1, 5 * cm), P('Project Budget Calculator', 'title'), Spacer(1, 6),
          P('User guide: every sheet, every column, every formula', 'sub'), Spacer(1, 1.2 * cm)]
story.append(Table([['']], colWidths=[PW], rowHeights=[3], style=[('BACKGROUND', (0, 0), (-1, -1), RED)]))
story += [Spacer(1, 0.8 * cm),
          P('Workbook: <b>Project_Budget_Calculator.xlsx</b>'),
          P('Based on: the <i>Revenue Forecast Calculator</i> slide and the clarifications agreed on 6 October 2026'),
          P('Capacity: 50 projects · up to 24 months per project · 36-month calendar timeline (Jan 2026 – Dec 2028 by default)'),
          Spacer(1, 3 * cm),
          P('<b>About the screenshots.</b> The screenshots in this guide use six sample projects so that every '
            'view has something to show. Empty project rows are hidden in the screenshots so the totals rows fit. The delivered workbook has only the one example row from the slide. Overwrite it or delete it '
            'when you add your own projects.', 'note'),
          NextPageTemplate('port'), PageBreak()]

# ------------------------------------------------------------------ TOC
toc = TableOfContents()
toc.levelStyles = [S['toc1'], S['toc2']]
toc.dotsMinLevel = 0
story += [P('Contents', 'h3'), toc, PageBreak()]

# ------------------------------------------------------------------ 1 overview
story += [H1('1. Overview'),
          P('The workbook keeps a portfolio of projects and answers one question for each of them: <b>how much of the '
            'contracted budget is still to be earned, and in which months?</b> That remaining amount is the '
            '<b>Budgeted</b> balance. The workbook spreads it over the months the project has left, using a phasing profile you choose.'),
          H2('1.1 The two formulas'),
          P('Everything in the workbook comes from two rules on the original slide:'),
          P('Budgeted = Contracted Budget − WIP to date<br/>'
            'Phased Budgeted(k) = Budgeted × weight(k) ÷ Σ weights of the remaining months', 'formula'),
          P('<b>WIP to date</b> is the sum of the WIP actuals you have logged for every month up to and including the '
            '<b>Current Month</b>. The <b>remaining months</b> are the project months after the Current Month. '
            'The weights of those months are renormalised so they add up to 1.0. That way the whole Budgeted balance, no more and no less, '
            'lands in the months that are left.'),
          H2('1.2 How the sheets fit together'),
          table([
              ['Sheet', 'Role', 'You type here?', 'Slide page'],
              ['README', 'Built-in quick reference', 'No', '–'],
              ['Projects', 'Project ∑ table: master list, Current Month, key results, status', 'Yes', '1 · Project ∑Table'],
              ['Phasing', 'Raw phasing weights per project month', 'Yes', '(Phasing inputs)'],
              ['WIP Log', 'Monthly WIP actuals on the calendar', 'Yes', '(WIP inputs)'],
              ['Project Page', 'Detail and chart for one selected project', 'Only the selector', '2 · Project Page'],
              ['Timeline', 'Gantt-style view of every project, month by month', 'No', '3 · Project Timeline'],
              ['Aggregator', 'Portfolio totals per month and per year against TRM', 'Only TRM', '4 · Aggregator'],
              ['Phased Budget', 'Calculation grid feeding the views', 'No', '–'],
          ], [2.9 * cm, 7.6 * cm, 2.8 * cm, 4.1 * cm]),
          Spacer(1, 8),
          P('Data flows one way: <b>Projects + Phasing + WIP Log → Phased Budget → Project Page, Timeline and Aggregator</b>. '
            'Every project sits on the same row number on every per-project sheet (project 1 is row 6, project 50 is row 55). '
            'So when you look at row 9 on the Phasing sheet, you are looking at the same project as row 9 on Projects.'),
          H2('1.3 Colour conventions'),
          table([
              ['Look', 'Meaning', 'Where'],
              ['<font color="#0000FF">Blue text</font>', 'A value you type (hard-coded input)', 'Project fields, weights, WIP amounts, TRM'],
              ['Yellow fill', 'A key setting or selector', 'Current Month, Timeline Start, TRM column, project selector'],
              ['Light-yellow fill', 'Input cell inside the project\'s active window', 'Phasing and WIP Log grids'],
              ['Grey fill', 'Calculated column, or a cell outside the project\'s window', 'Projects calc columns; Phasing / WIP Log grids'],
              ['Black text', 'Formula: don\'t overwrite', 'All calculated cells'],
              ['<font color="#008000">Green text</font>', 'A link that pulls a value from another sheet', 'Names, dates and figures repeated across sheets'],
              ['Red / pink highlight', 'Something needs your attention', 'Status column; WIP logged in a future month'],
          ], [3.4 * cm, 6.4 * cm, 7.6 * cm]),
          CondPageBreak(10 * cm)]

# ------------------------------------------------------------------ 2 getting started
story += [H1('2. Getting started'),
          H2('2.1 First-time setup'),
          *steps([
              '<b>Set the Timeline Start</b> (Projects!C3) to the first month you want on the calendar. The default is Jan 2026. '
              'Do this <i>before</i> logging any WIP (see the warning in section 4.4).',
              '<b>Set the Current Month</b> (Projects!C2) to the latest month whose WIP you know. The default is Oct 2026.',
              '<b>Delete or overwrite the example row</b> on Projects (row 6), together with its weights on Phasing row 6 '
              'and its 1,000 WIP in Oct 2026 on WIP Log row 6.',
              '<b>Add your projects</b> on Projects: Name, Engagement Manager, Starting Month, Duration, Contracted Budget. '
              'Use the next empty row each time.',
              '<b>Enter phasing weights</b> on Phasing for each project, or leave the row blank for equal weights.',
              '<b>Log any WIP to date</b> on WIP Log, in the calendar-month columns.',
              '<b>Check the Status column</b> on Projects. Every project should read <i>OK</i>.',
          ]),
          H2('2.2 The monthly routine'),
          P('Once set up, each month-end comes down to two edits:'),
          *steps([
              'On <b>WIP Log</b>, enter the WIP actual for the month just closed, for each project.',
              'On <b>Projects</b>, move <b>Current Month</b> forward one month.',
          ]),
          P('That is all. WIP to date, Budgeted, the remaining months, the re-phased forecast, the timeline, the project '
            'page and the aggregator all recalculate. Any shortfall or overrun in the month you just closed is spread '
            'automatically over the months that are left.'),
          P('<b>Tip:</b> the order matters only for a moment. WIP logged in a month <i>after</i> the Current Month is '
            'ignored (and shown struck through in red) until the Current Month reaches it. So you can log it first and move the month '
            'second, or the other way round.', 'note'),
          H2('2.3 Adding, filtering and visualising'),
          P('The slide asks for <i>create new</i>, <i>filter</i> and <i>visualize</i> buttons. Excel can\'t add real '
            'buttons without macros, so the workbook does this instead:'),
          table([
              ['Slide button', 'In the workbook'],
              ['Create new', 'Type the new project into the next empty row on Projects. All 50 rows are already wired '
                             'through every sheet, so nothing else needs to be copied.'],
              ['Filter', 'Use the filter arrows in the Projects header row. For example, filter on Engagement Manager or Status.'],
              ['Visualize', 'Go to Project Page and pick the project in the yellow dropdown, or look at Timeline / Aggregator.'],
          ], [3.4 * cm, 14 * cm]),
          PageBreak()]

# ------------------------------------------------------------------ 3 concepts
story += [H1('3. Key concepts'),
          H2('3.1 Current Month: actuals vs forecast'),
          P('The Current Month is the line between the past and the future. For every project:'),
          *bullets(['Months <b>up to and including</b> the Current Month are <b>actuals</b>. Their value is the WIP you logged.',
                    'Months <b>after</b> the Current Month are <b>forecast</b>. Their value is the Phased Budgeted amount.',
                    'Moving the Current Month forward turns a forecast month into an actual month. The Budgeted balance '
                    'is then re-spread over the smaller set of months that are left.']),
          P('Only the year and month of the date count, so 1 Oct 2026 and 17 Oct 2026 are treated the same.'),
          H2('3.2 Phasing weights and renormalisation'),
          P('Weights describe the shape of a project\'s workload. Enter them as any non-negative numbers, for example '
            '1, 2, 2, 2, 2 or 10%, 20%, 20%, 25%, 25%. Only their relative size matters. The workbook renormalises them twice:'),
          *bullets(['<b>Over the full duration</b>, for the <i>plan weights</i> on Phasing (the right-hand block) and the '
                    '<i>Original Plan</i> column on Project Page. They always add up to 100%.',
                    '<b>Over the remaining months only</b>, for the Phased Budgeted forecast. The weights of months already in '
                    'the past drop out, and the rest are scaled back up to 100%.']),
          P('If a project has <b>no weights at all</b>, every month gets weight 1 (equal phasing). If some weights '
            'are entered, blank months count as 0.'),
          H2('3.3 Worked example: the slide'),
          P('The slide shows a five-month project phased I 1k · II 2k · III 2k · IV 2k · V 2k. As agreed: contract '
            '<b>10,000</b>, weights <b>1 : 2 : 2 : 2 : 2</b>, start Oct 2026, and <b>1,000</b> of WIP logged in month I '
            '(Oct 2026, the Current Month).'),
          table([
              ['Step', 'Calculation', 'Result'],
              ['WIP to date', 'WIP logged for months ≤ Oct 2026', '1,000'],
              ['Budgeted', '10,000 − 1,000', '9,000'],
              ['Remaining months', 'Nov 2026 – Feb 2027 (months II–V)', '4'],
              ['Remaining weights', '2 + 2 + 2 + 2', '8'],
              ['Phased Budgeted per month', '9,000 × 2 ÷ 8', '2,250'],
              ['Check', '1,000 actual + 4 × 2,250 forecast', '10,000 = contract ✓'],
          ], [4.2 * cm, 8.2 * cm, 5 * cm]),
          Spacer(1, 6),
          P('Compare the <i>Original Plan</i> on Project Page: 10,000 × 1/9 = 1,111 for month I and 10,000 × 2/9 = 2,222 '
            'for each later month. Month I came in 111 below plan, and that 111 is now spread across months II–V '
            '(2,250 instead of 2,222).'),
          PageBreak()]

# ------------------------------------------------------------------ 4 sheet by sheet
story += [H1('4. Sheet-by-sheet reference'),
          P('Each section below covers what the sheet is for, what it looks like, every column, what you type, and how its '
            'numbers are worked out. Wide sheets are shown in several screenshots (12 months at a time, names repeated), and the unused project rows (7–50) are hidden so the totals rows fit.'),
          H2('4.1 README'),
          P('A one-page summary inside the workbook covering the formulas, the sheet list, the colour key, the monthly routine and the '
            'limits. It has no formulas and no inputs. Keep it as a quick reminder for colleagues who get the file without this guide.'),
          img('readme', PW, 'Figure 1: README sheet', maxh=17 * cm),
          PageBreak()]

# Projects
story += [H2('4.2 Projects (Project ∑ Table)'),
          P('The master list and the main place to work. Each row is one project: you fill in the first five fields '
            'and the sheet works out the rest. The two settings at the top drive the whole workbook.'),
          H3('Settings'),
          table([
              ['Cell', 'Name', 'What it does'],
              ['C2', 'Current Month', 'Divides actuals (≤) from forecast (>). Move it forward one month each month-end.'],
              ['C3', 'Timeline Start', 'First month of the 36-month calendar used by WIP Log, Phased Budget, Timeline and '
                                       'Aggregator. Set it once, before you log WIP.'],
          ], [1.6 * cm, 3.2 * cm, 12.6 * cm]),
          H3('Columns (rows 6–55, one project per row)'),
          table([
              ['Col', 'Header', 'Type', 'Meaning / formula'],
              ['A', '#', '–', 'Project slot number 1–50.'],
              ['B', 'Project Name', 'Input', 'Must be unique. It is the key used by the Project Page dropdown. A row with no name is ignored everywhere.'],
              ['C', 'Engagement Manager', 'Input', 'Free text. Handy for filtering.'],
              ['D', 'Starting Month', 'Input', 'Any date in the first month of the project. Shown as "Oct 2026".'],
              ['E', 'Duration (months)', 'Input', 'Whole number 1–24 (enforced by data validation).'],
              ['F', 'End Month', 'Calc', 'Starting Month + Duration − 1 months.'],
              ['G', 'Contracted Budget', 'Input', 'Total contract value, in plain units (10,000, not 10k).'],
              ['H', 'WIP to Date', 'Calc', 'From WIP Log column C: the sum of WIP for months ≤ Current Month.'],
              ['I', 'Budgeted (Contract − WIP)', 'Calc', 'G − H. The balance still to be phased.'],
              ['J', 'Remaining Months', 'Calc', 'Project months after the Current Month: Duration − first remaining month # + 1 (never below 0).'],
              ['K', 'Phased Budgeted – Next Month', 'Calc', 'The forecast for the month right after the Current Month.'],
              ['L', 'Phased Budgeted – Rest of Current Year', 'Calc', 'Sum of the forecast for the months after the Current Month, up to December of that year.'],
              ['M', 'Current-Year Forecast (WIP + Phased)', 'Calc', 'WIP logged in the current year up to the Current Month, plus column L. '
                                                                     'Gives the project\'s full-year outturn.'],
              ['N', 'Status', 'Calc', 'Health check. Reads <i>OK</i>, or names the first problem it finds (see section 5).'],
          ], [1 * cm, 4.2 * cm, 1.3 * cm, 10.9 * cm]),
          Spacer(1, 6),
          P('<b>Totals row (57)</b> adds up columns G, H, I, K, L and M. Cell N57 counts the projects whose Status is not OK. '
            'The <b>header filters</b> (row 5) cover all 50 rows, and panes are frozen so the names stay visible as you scroll.'),
          P('<b>Do not</b> insert or delete rows or columns on any project sheet. Every sheet relies on project <i>n</i> sitting '
            'on row <i>n</i> + 5. To remove a project, clear its input cells on Projects, Phasing and WIP Log instead.', 'note')]
story += FIGS_projects

# Phasing
story += [H2('4.3 Phasing'),
          P('Holds the phasing profile of each project. The grid on the left (<b>M1–M24</b>, columns I–AF) is where you type. '
            '<b>M1 is the Starting Month</b>, M2 the month after, and so on. These are project months, not calendar months. '
            'The cells inside the project\'s duration turn light yellow, and the cells beyond it turn grey.'),
          table([
              ['Col', 'Header', 'Meaning / formula'],
              ['A–C', '#, Project Name, Duration', 'Pulled from Projects (green).'],
              ['D', 'Weights entered', 'How many weight cells have a number. 0 means equal phasing.'],
              ['E', 'Σ weights (full duration)', 'Sum of weights M1…M(Duration), or the Duration itself when no weights are entered.'],
              ['F', 'First remaining month #', 'The project month right after the Current Month. Example: start Aug, Current Month Oct → 4. '
                                               'It is 1 for projects that haven\'t started yet.'],
              ['G', 'Σ weights (remaining months)', 'Sum of weights from month F to month Duration. This is the divisor in the Phased '
                                                    'Budgeted formula. If it is 0 while money is left, Status warns you.'],
              ['H', 'Non-zero weights beyond duration', 'Counts weights typed past the Duration. They are ignored, and Status mentions it.'],
              ['I–AF', 'M1 … M24 (input)', 'Raw weights. Any non-negative number; blanks count as 0 (unless the whole row is blank).'],
              ['AH–BE', 'M1 … M24 (normalised)', 'Each weight ÷ column E, so the row adds up to 100% over the full duration. These are the '
                                                 'plan weights used for the Original Plan on Project Page.'],
              ['BF', 'Check Σ', 'Should show 100.0% for every active project.'],
          ], [1.4 * cm, 4.6 * cm, 11.4 * cm]),
          Spacer(1, 6),
          P('Row 2 holds the numbers 1–24 above each block. The formulas use them as month indexes, so leave them alone.'),
          H3('Typical profiles'),
          table([
              ['Profile', 'Example weights (6 months)', 'Use when'],
              ['Flat', '(leave blank)', 'Work is spread evenly'],
              ['Ramp-up', '1, 2, 3, 3, 3, 3', 'Slow start, steady delivery'],
              ['Front-loaded', '3, 3, 2, 1, 1, 1', 'Heavy design or set-up phase'],
              ['Back-loaded', '0, 0, 1, 1, 3, 3', 'Delivery-heavy or acceptance-driven projects'],
              ['Bell', '1, 2, 3, 3, 2, 1', 'Typical build project'],
          ], [3.2 * cm, 5.4 * cm, 8.8 * cm])]
story += FIGS_phasing1

# WIP Log
story += [H2('4.4 WIP Log'),
          P('Monthly WIP actuals for each project, laid out on the <b>calendar</b> (columns D–AM = 36 months from the Timeline '
            'Start). Type the WIP earned in each month in that month\'s column.'),
          table([
              ['Area', 'Meaning'],
              ['Row 4', '"actual" over months ≤ Current Month, "future" over later months.'],
              ['Row 5', 'Calendar month headers (Timeline Start, then +1 month each column).'],
              ['Column C', 'WIP to Date: the sum of the row for months ≤ Current Month. Feeds Projects column H.'],
              ['Light-yellow cells', 'Inside the project\'s window and ≤ Current Month. The normal place to type.'],
              ['Grey cells', 'Outside the project\'s window. A value here still counts towards WIP to date if ≤ Current Month. '
                             'It is allowed (for example, late WIP after the end date) but shown on a grey background.'],
              ['Red, struck-through', 'A value in a month after the Current Month. It is ignored until the Current Month reaches it.'],
              ['Row 57', 'Totals per month. Feeds the Σ WIP column on the Aggregator.'],
          ], [3.6 * cm, 13.8 * cm]),
          Spacer(1, 6),
          P('<b>Warning: Timeline Start.</b> WIP values are stored by column, not by date. If you change the Timeline Start after logging '
            'WIP, every value moves to a different month. If you ever need to move the timeline, cut and paste the WIP grid '
            'sideways by the same number of months first.', 'note'),
          P('WIP can be negative (for example, a reversal). It lowers WIP to date and raises Budgeted.')]
story += FIGS_wiplog1

# Project Page
story += [H2('4.5 Project Page'),
          P('The single-project view ("visualize"). Pick a project in the yellow dropdown at <b>B3</b>. The list is the 50 '
            'project names from Projects. Everything else on the page fills in for that project.'),
          H3('Header block (rows 5–13)'),
          P('Engagement Manager, Starting Month, Duration, End Month, Contracted Budget, WIP to Date, Budgeted, Remaining Months '
            'and Status, all pulled from the project\'s row on Projects.'),
          H3('Monthly table (rows 17–40, one row per project month)'),
          table([
              ['Column', 'Meaning / formula'],
              ['Project Month', '1 … Duration. Rows past the duration stay blank.'],
              ['Calendar Month', 'Starting Month + (k − 1) months.'],
              ['Raw Weight', 'Weight from Phasing (1 when the project uses equal weights).'],
              ['Plan Weight (Σ=1)', 'Weight normalised over the full duration.'],
              ['Original Plan', 'Contracted Budget × Plan Weight: what the month was worth before any WIP.'],
              ['WIP Actual', 'WIP Log value for that calendar month, if ≤ Current Month; otherwise 0.'],
              ['Phased Budgeted', 'Value from the Phased Budget grid (non-zero only after the Current Month).'],
              ['Total (WIP + Phased)', 'Actual for past months plus forecast for future months.'],
              ['Actual / Forecast', 'Label for the row.'],
          ], [4 * cm, 13.4 * cm]),
          Spacer(1, 6),
          P('Row 41 totals the table, and row 42 checks that <b>Total = Contracted Budget</b> ("✓ ties"). A difference means part of '
            'the budget couldn\'t be phased (see Status), or that WIP was logged outside the project\'s months. '
            'Cell K1 holds the selected project\'s row number for the formulas. Don\'t edit it.'),
          H3('Chart'),
          P('Stacked columns show <b>WIP Actual</b> (blue) and <b>Phased Budgeted</b> (red) per month. A green line shows the '
            '<b>Original Plan</b>, so you can see at a glance where the forecast now differs from the plan.'),
          img('projectchart', 13 * cm, 'Figure 6: Project Page chart for the slide example: 1,000 actual in Oct, then 2,250 a month against a plan of 2,222.')]
story += port_fig('projectpage', 'Figure 5: Project Page for "Example Project (slide)": header block, the 24-row monthly table, '
                                  'the totals row and the "ties" check.', '4.5 Project Page: screenshot')

# Timeline
story += [H2('4.6 Timeline'),
          P('A Gantt-style view of the whole portfolio across the 36-month calendar. It is all formulas, with nothing to type. Each cell shows:'),
          *bullets(['<b>Dark orange</b>: the WIP actual for a month ≤ Current Month inside the project window.',
                    '<b>Light orange</b>: the Phased Budgeted forecast for a month after the Current Month.',
                    'Blank: outside the project window. A WIP value logged outside the window still shows, so it isn\'t hidden.',
                    'The <b>red-bordered column</b> is the Current Month.']),
          P('Columns A–E show the slot number, name, Engagement Manager, start and end. Use it to spot overlaps, gaps in WIP '
            'logging (a white cell inside a project\'s past months), and months where a lot of forecast bunches up.'),
          P('Read across a row and the numbers add up to the project\'s Contracted Budget, as long as its Status is OK.')]
story += FIGS_timeline1

# Aggregator
story += [H2('4.7 Aggregator'),
          P('Portfolio totals. It answers "what is the whole book worth each month and each year, and how does it compare with '
            'TRM?"'),
          H3('Monthly table (rows 6–41)'),
          table([
              ['Col', 'Header', 'Meaning / formula'],
              ['A–B', 'Month, Year', 'The 36 calendar months and their year.'],
              ['C', 'Σ WIP (actual)', 'WIP Log total for the month, for months ≤ Current Month; 0 after.'],
              ['D', 'Σ Phased Budgeted', 'Phased Budget total for the month (non-zero only after the Current Month).'],
              ['E', 'Total (WIP + Phased)', 'C + D: actuals for the past, forecast for the future.'],
              ['F', 'TRM (input)', '<b>Type</b> your monthly TRM target here (yellow). Leave a month blank if you have no target for it.'],
              ['G', 'Variance (Total − TRM)', 'Positive = ahead of TRM, negative (in brackets) = behind. Blank where TRM is blank.'],
          ], [1.4 * cm, 4.2 * cm, 11.8 * cm]),
          Spacer(1, 6),
          P('The Current Month row is shaded. Row 42 totals the columns.'),
          H3('Annual (calendar year) table, I6:N10'),
          P('For each of the three timeline years: Σ WIP, Σ Phased Budget, <b>WIP + Phased Budget</b> (the slide\'s annual '
            '{WIP + Phased Budget}), TRM, and the variance, followed by a total row. Years run January to December.'),
          H3('Reconciliation, I13:M16'),
          P('Σ Contracted Budget − Σ WIP to date − Σ Phased Budgeted should be <b>0</b> ("✓ fully phased"). If it isn\'t, some '
            'budget couldn\'t be placed in a month: there are no remaining months, the remaining weights are zero, or part of a project '
            'falls outside the 36-month timeline. Go to Projects and look at the Status column.'),
          H3('Chart'),
          P('Stacked columns show <b>Σ WIP</b> (blue, the past) and <b>Σ Phased Budgeted</b> (red, the future) per month. '
            'The <b>TRM</b> line (green) sits on top. Past months show WIP because the Phased Budgeted amount is zero by '
            'definition once a month becomes actual.')]
story += port_fig('aggregator', 'Figure 8: Aggregator monthly table, all 36 months (Jan 2026 – Dec 2028) and the totals row, '
                                 'with a sample TRM of 25,000 a month entered for 2026–2027.', '4.7 Aggregator: monthly table')
story += FIGS_aggannual

# Phased Budget
story += [H2('4.8 Phased Budget (calculation grid)'),
          P('The engine room. It has one row per project and one column per calendar month (H–AQ), and each cell holds that '
            'project\'s Phased Budgeted amount for that month. It has no inputs. Every view reads from it.'),
          table([
              ['Col', 'Header', 'Meaning'],
              ['A–D', '#, Name, Starting Month, Duration', 'Pulled from Projects.'],
              ['E', 'Budgeted', 'Projects column I.'],
              ['F', 'Σ remaining weights', 'Phasing column G (the divisor).'],
              ['G', 'Equal weights?', 'TRUE when the project has no weights entered.'],
              ['H–AQ', 'Calendar months', 'The Phased Budgeted amount (formula below).'],
          ], [1.4 * cm, 5 * cm, 11 * cm]),
          Spacer(1, 6),
          P('For calendar month m, the project month is k = (m − Starting Month) + 1. The cell is:', 'body'),
          P('0  if the project is incomplete, Σ remaining weights = 0,<br/>'
            '   m ≤ Current Month, or k is outside 1 … Duration<br/>'
            'otherwise  Budgeted × weight(k) ÷ Σ remaining weights', 'formula'),
          P('Row 57 totals each month and feeds the Aggregator.')]
story += FIGS_phased1

# ------------------------------------------------------------------ 5 status
story += [H1('5. Status messages and troubleshooting'),
          P('Projects column N checks each project in the order below and shows the <b>first</b> problem it finds. Problem rows turn '
            'red. N57 counts how many need attention.'),
          table([
              ['Status', 'Cause', 'Fix'],
              ['OK', 'All checks passed.', '–'],
              ['Missing start / duration / contract', 'The row has a name but no Starting Month, Duration or Contracted Budget.', 'Fill in the missing field.'],
              ['Duration must be 1–24', 'Duration outside the supported range.', 'Correct it. For longer projects, see section 7.'],
              ['WIP exceeds contract', 'WIP to date > Contracted Budget, so Budgeted is negative and a negative amount is phased.',
               'Check the WIP Log for typos, or raise the contract if it was varied.'],
              ['Budget not phased: no remaining months', 'The Current Month is at or past the End Month, but money is still left (or overspent).',
               'Log the missing WIP, extend the Duration, or reduce the contract to what was actually earned.'],
              ['Budget not phased: remaining weights are 0', 'Months are left, but every one of their weights is 0.',
               'Put a weight on at least one remaining month on Phasing.'],
              ['Partly outside timeline', 'The project starts before Timeline Start or ends after the 36th month. Amounts in those months are not shown.',
               'Expected for old or very long projects. Otherwise check the dates.'],
              ['Weights entered beyond duration (ignored)', 'Non-zero weights typed past the project\'s Duration.',
               'Clear them, or increase the Duration if they were meant to count.'],
          ], [4.6 * cm, 6.6 * cm, 6.2 * cm]),
          H2('5.1 Other things to check'),
          table([
              ['Symptom', 'Likely cause'],
              ['Project Page is blank and shows "Pick a project…"', 'The name in B3 doesn\'t match any project name (it was renamed or deleted). Pick it again from the dropdown.'],
              ['Project Page check shows "✗ diff"', 'Budget couldn\'t be phased (see Status), or WIP was logged outside the project months.'],
              ['A WIP figure isn\'t counted', 'It is in a month after the Current Month (red strike-through). Move the Current Month forward.'],
              ['Numbers jumped after changing Timeline Start', 'WIP is stored by column. See the warning in section 4.4.'],
              ['Two projects get mixed up on Project Page', 'Duplicate names. The dropdown always finds the first match, so keep names unique.'],
              ['Aggregator reconciliation not 0', 'At least one project isn\'t OK. Filter Status on Projects.'],
          ], [6.2 * cm, 11.2 * cm]),
          PageBreak()]

# ------------------------------------------------------------------ 6 examples
story += [H1('6. More worked examples'),
          P('These use the sample projects in the screenshots, all with the Current Month at Oct 2026.'),
          H2('6.1 Equal weights: Data Platform Migration'),
          table([
              ['Item', 'Value'],
              ['Contract / start / duration', '120,000 · Jun 2026 · 12 months (Jun 2026 – May 2027) · no weights'],
              ['WIP logged', '9,000 × 5 months (Jun–Oct) = 45,000'],
              ['Budgeted', '120,000 − 45,000 = 75,000'],
              ['Remaining months', 'Nov 2026 – May 2027 = 7 (all weight 1)'],
              ['Phased Budgeted', '75,000 ÷ 7 = 10,714 per month'],
          ], [5 * cm, 12.4 * cm]),
          H2('6.2 Shaped weights after a slow start: Cloud Cost Review'),
          table([
              ['Item', 'Value'],
              ['Contract / start / duration', '18,000 · Aug 2026 · 6 months · weights 2, 2, 1, 1, 1, 1'],
              ['Original plan', '18,000 × 2/8 = 4,500 for Aug and Sep; 2,250 for each later month'],
              ['WIP logged', 'Aug 4,000 · Sep 4,000 · Oct 3,000 = 11,000'],
              ['Budgeted', '18,000 − 11,000 = 7,000'],
              ['Remaining months', 'Nov, Dec, Jan = project months 4–6, weights 1 + 1 + 1 = 3'],
              ['Phased Budgeted', '7,000 × 1/3 = 2,333 per month (each above the 2,250 plan, because Aug–Oct came in 750 under plan)'],
          ], [5 * cm, 12.4 * cm]),
          H2('6.3 A project that hasn\'t started: Security Audit'),
          table([
              ['Item', 'Value'],
              ['Contract / start / duration', '30,000 · Mar 2027 · 4 months · weights 1, 2, 2, 1'],
              ['WIP / Budgeted', '0 / 30,000'],
              ['Phased Budgeted', 'All four months remain: 30,000 × 1/6, 2/6, 2/6, 1/6 = 5,000 · 10,000 · 10,000 · 5,000'],
          ], [5 * cm, 12.4 * cm]),
          H2('6.4 A finished project: CRM Rollout'),
          P('9 months, Jan–Sep 2026, contract 45,000, with 5,000 of WIP logged every month. WIP to date = 45,000, so Budgeted = 0 and '
            'there are no remaining months. Nothing is left to phase, so the Status is <i>OK</i>. If the WIP had added up to 44,000, the Status '
            'would read <i>Budget not phased: no remaining months</i>, flagging the 1,000 that was never earned.'),
          PageBreak()]

# ------------------------------------------------------------------ 7 limits
story += [H1('7. Limits and changing the size'),
          table([
              ['Limit', 'Value', 'Notes'],
              ['Projects', '50', 'Rows 6–55 on every project sheet.'],
              ['Duration per project', '24 months', 'Enforced on Projects column E.'],
              ['Calendar timeline', '36 months', 'From Timeline Start (default Jan 2026 – Dec 2028).'],
              ['Annual table', '3 calendar years', 'Follows the timeline.'],
              ['Units', 'Plain numbers', 'No currency symbol. Enter full amounts (10000 for 10k).'],
          ], [4.2 * cm, 3.4 * cm, 9.8 * cm]),
          Spacer(1, 8),
          P('The workbook is generated by <b>tools/build_budget_calculator.py</b> in the repository. To change the capacity, edit '
            'the constants at the top of the script (<font face="DVM">N</font> = projects, <font face="DVM">MAXDUR</font> = '
            'maximum duration, <font face="DVM">TL</font> = timeline months), run it, and copy your data across. Don\'t try to '
            'stretch the grids by hand: the row and column layout is the same on every sheet, and hand edits break that.'),
          P('python3 tools/build_budget_calculator.py Project_Budget_Calculator.xlsx', 'formula'),
          H2('7.1 Things the workbook does not do'),
          *bullets(['There are no macros, so there are no real buttons (see section 2.3).',
                    'It keeps no history of earlier forecasts. Save a copy of the file each month-end if you need snapshots.',
                    'There are no currencies or FX. Every amount is assumed to be in the same unit.',
                    'TRM is typed in by hand each month. It isn\'t derived from the projects.']),
          H2('7.2 Glossary'),
          table([
              ['Term', 'Meaning'],
              ['Contracted Budget', 'Total agreed value of the project.'],
              ['WIP', 'Work in progress: value earned in a month (an actual).'],
              ['WIP to date', 'Sum of WIP for months up to and including the Current Month.'],
              ['Budgeted', 'Contracted Budget − WIP to date: what is left to earn.'],
              ['Phasing / weights', 'The relative share of the work in each project month.'],
              ['Phased Budgeted', 'The Budgeted balance spread over the remaining months by their weights.'],
              ['Remaining months', 'Project months after the Current Month.'],
              ['Original Plan', 'Contract × full-duration weights: the forecast before any WIP.'],
              ['TRM', 'The monthly target figure you enter on the Aggregator for comparison.'],
          ], [4.2 * cm, 13.2 * cm]),
          ]

doc = Doc(OUT)
doc.multiBuild(story)
print('ok', OUT)
