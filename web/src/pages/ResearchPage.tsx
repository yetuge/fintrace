import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  GitBranch,
  Github,
  Layers3,
  Search,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import {
  annualGrowth,
  buildReport,
  claims,
  cloudShare,
  financials,
  sources,
  stages,
  type Claim,
} from '../features/research/case';
import '../styles/research.css';

type View = 'overview' | 'evidence' | 'workflow' | 'report';
const views = [
  { id: 'overview' as const, label: '研究概览', icon: Layers3 },
  { id: 'evidence' as const, label: '证据库', icon: BookOpen },
  { id: 'workflow' as const, label: '研究流程', icon: Workflow },
  { id: 'report' as const, label: '研究草稿', icon: FileText },
];

function RevenueChart() {
  const max = 260000;
  return (
    <div className="ft-chart" aria-label="年度收入比较，单位百万美元">
      <div className="ft-chart-legend">
        <span>
          <i className="ft-dot ft-dot-muted" />
          FY2023
        </span>
        <span>
          <i className="ft-dot" />
          FY2024
        </span>
      </div>
      {[
        { name: '公司总收入', a: financials.previous, b: financials.current },
        {
          name: 'Intelligent Cloud',
          a: financials.cloudPrevious,
          b: financials.cloudCurrent,
        },
      ].map((row) => (
        <div className="ft-chart-row" key={row.name}>
          <span className="ft-chart-label">{row.name}</span>
          <div className="ft-bars">
            <div>
              <span
                className="ft-bar ft-bar-muted"
                style={{ width: `${(row.a / max) * 100}%` }}
              />
              <b>{row.a.toLocaleString('en-US')}</b>
            </div>
            <div>
              <span
                className="ft-bar"
                style={{ width: `${(row.b / max) * 100}%` }}
              />
              <b>{row.b.toLocaleString('en-US')}</b>
            </div>
          </div>
        </div>
      ))}
      <div className="ft-chart-axis">
        <span>0</span>
        <span>100,000</span>
        <span>200,000</span>
        <span>百万美元</span>
      </div>
    </div>
  );
}

export function ResearchPage() {
  const [view, setView] = useState<View>('overview');
  const [selected, setSelected] = useState('C1');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [reviewed, setReviewed] = useState(false);
  const [activeStage, setActiveStage] = useState(2);
  const claim = claims.find((c) => c.id === selected)!;
  const filtered = claims.filter(
    (c) =>
      (filter === 'all' || c.kind === filter) &&
      `${c.title} ${c.summary} ${c.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([buildReport(reviewed)], {
        type: 'text/markdown;charset=utf-8',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'fintrace-microsoft-fy2024.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectClaim = (c: Claim) => {
    setSelected(c.id);
  };

  return (
    <div className="ft-app">
      <a href="#research-content" className="ft-skip">
        跳到研究内容
      </a>
      <aside className="ft-sidebar">
        <Link to="/" className="ft-brand" aria-label="FinTrace 首页">
          <img src={`${import.meta.env.BASE_URL}fintrace.svg`} alt="" />
          <span>
            FinTrace<small>多源金融研究 Agent</small>
          </span>
        </Link>
        <div className="ft-workspace">
          <span className="ft-workspace-icon">
            <GitBranch size={17} />
          </span>
          <div>
            金融研究工作区<small>公开案例演示</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="ft-nav-label">工作空间</div>
        <nav aria-label="研究导航">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`ft-nav-item ${view === id ? 'is-active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              {label}
              {id === 'evidence' && <span>4</span>}
            </button>
          ))}
        </nav>
        <div className="ft-sidebar-case">
          <div className="ft-nav-label">当前研究</div>
          <button onClick={() => setView('overview')}>
            <span className="ft-case-dot" />
            <span>
              微软年度收入核对<small>Microsoft · FY2024</small>
            </span>
          </button>
        </div>
        <div className="ft-sidebar-bottom">
          <div className="ft-principle">
            <ShieldCheck size={19} />
            <p>
              每个结论，都有来处。<small>事实、推导与未知，分别记录。</small>
            </p>
          </div>
          <a
            className="ft-sidebar-link"
            href="https://github.com/yetuge/fintrace"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={17} />
            项目源码
            <ArrowUpRight size={14} />
          </a>
          {import.meta.env.VITE_SHOWCASE_ONLY === 'true' ? (
            <a
              className="ft-sidebar-link"
              href="https://github.com/yetuge/fintrace#运行-agent-工作台"
              target="_blank"
              rel="noreferrer"
            >
              <Layers3 size={17} />
              运行 Agent 工作台
              <ArrowUpRight size={14} />
            </a>
          ) : (
            <Link className="ft-sidebar-link" to="/chat">
              <Layers3 size={17} />
              进入 Agent 工作台
              <ChevronRight size={14} />
            </Link>
          )}
          <div className="ft-user">
            <span>F</span>
            <div>
              FinTrace 演示<small>本地资料 · 无需 API Key</small>
            </div>
          </div>
        </div>
      </aside>

      <div className="ft-shell">
        <header className="ft-topbar">
          <div className="ft-breadcrumb">
            研究工作区
            <ChevronRight size={14} />
            <strong>{views.find((v) => v.id === view)?.label}</strong>
          </div>
          <div className="ft-topbar-right">
            <span className="ft-demo-badge">
              <i />
              公开财报演示案例
            </span>
            <a
              href="https://github.com/yetuge/fintrace#快速体验"
              target="_blank"
              rel="noreferrer"
              aria-label="查看项目说明"
            >
              <CircleHelp size={19} />
            </a>
            <span className="ft-avatar">F</span>
          </div>
        </header>
        <main id="research-content" className="ft-main">
          <div className="ft-heading">
            <div>
              <div className="ft-heading-context">
                <span className="ft-company-icon">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span>Microsoft Corporation</span>
                <span className="ft-ticker">NASDAQ: MSFT</span>
              </div>
              <h1>微软 FY2024 收入增长核对</h1>
              <p>从一手披露到研究结论，让每一步判断都可以回溯。</p>
            </div>
            <button className="ft-button ft-button-primary" onClick={download}>
              <Download size={16} />
              导出研究草稿
            </button>
          </div>

          <section className="ft-question" aria-label="研究问题">
            <div className="ft-question-icon">
              <Search size={19} />
            </div>
            <div>
              <strong>
                全年收入增长多少，Intelligent Cloud 是否是主要增量来源？
              </strong>
              <p>为什么同一份业绩公告同时出现约 16% 和约 15% 的收入增速？</p>
            </div>
            <span className="ft-status">
              {reviewed ? '演示中已复核' : '待人工复核'}
            </span>
          </section>
          <div className="ft-scope">
            <span>
              <b>研究期间</b> FY2024 / FY2023
            </span>
            <span>
              <b>金额单位</b> 百万美元
            </span>
            <span>
              <b>比较口径</b> 已报告 · 原始分部披露
            </span>
          </div>

          <div className="ft-tabs" role="tablist" aria-label="研究视图">
            {views.map(({ id, label, icon: Icon }) => (
              <button
                id={`tab-${id}`}
                key={id}
                role="tab"
                aria-selected={view === id}
                aria-controls={`panel-${id}`}
                className={view === id ? 'is-active' : ''}
                onClick={() => setView(id)}
              >
                <Icon size={16} />
                {label}
                {id === 'evidence' && <span>4</span>}
              </button>
            ))}
          </div>
          <div
            id={`panel-${view}`}
            role="tabpanel"
            aria-labelledby={`tab-${view}`}
          >
            {view === 'overview' && (
              <>
                <div className="ft-metrics">
                  <article>
                    <span>FY2024 总收入</span>
                    <strong>
                      245,122<small>百万美元</small>
                    </strong>
                    <p>
                      <span className="ft-positive">
                        +{annualGrowth.toFixed(2)}%
                      </span>{' '}
                      相比 FY2023
                    </p>
                  </article>
                  <article>
                    <span>全年收入增量</span>
                    <strong>
                      33,207<small>百万美元</small>
                    </strong>
                    <p>245,122 − 211,915</p>
                  </article>
                  <article>
                    <span>Intelligent Cloud 增量占比</span>
                    <strong>
                      {cloudShare.toFixed(2)}
                      <small>%</small>
                    </strong>
                    <p>分部增量 / 公司总增量</p>
                  </article>
                </div>
                <div className="ft-overview-grid">
                  <div className="ft-primary-column">
                    <section className="ft-panel">
                      <div className="ft-panel-heading">
                        <h2>收入比较</h2>
                        <span>FY2024 原始披露口径</span>
                      </div>
                      <RevenueChart />
                      <div className="ft-chart-footer">
                        <span>来源：Microsoft 年报 / SEC 分部披露</span>
                        <button
                          onClick={() => {
                            setSelected('C1');
                            setView('evidence');
                          }}
                        >
                          查看证据
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    </section>
                    <section className="ft-panel">
                      <div className="ft-panel-heading">
                        <h2>研究结论</h2>
                        <span>3 项有依据 · 1 项待补证</span>
                      </div>
                      <div className="ft-claim-list">
                        {claims.map((c) => (
                          <button
                            key={c.id}
                            className={`ft-claim-row ${selected === c.id ? 'is-selected' : ''}`}
                            onClick={() => selectClaim(c)}
                          >
                            <span
                              className={`ft-claim-icon ${c.kind === 'open' ? 'is-open' : ''}`}
                            >
                              {c.kind === 'open' ? (
                                <CircleHelp size={17} />
                              ) : (
                                <Check size={17} />
                              )}
                            </span>
                            <span>
                              <strong>{c.title}</strong>
                              <small>
                                {c.id} ·{' '}
                                {c.sourceIds.join(' / ') || '需要更细披露'}
                              </small>
                            </span>
                            <span
                              className={`ft-tag ${c.kind === 'open' ? 'ft-tag-amber' : ''}`}
                            >
                              {c.label}
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                      </div>
                    </section>
                  </div>
                  <EvidenceDetail claim={claim} />
                </div>
                <div className="ft-note">
                  <ShieldCheck size={16} />
                  <span>
                    公开财报与确定性计算构成演示资料；研究流程为设计示例，未执行实时抓取或模型调用。
                  </span>
                  <button onClick={() => setView('workflow')}>
                    了解研究流程
                    <ChevronRight size={14} />
                  </button>
                </div>
              </>
            )}

            {view === 'evidence' && (
              <div className="ft-evidence-grid">
                <section className="ft-panel">
                  <div className="ft-panel-heading">
                    <h2>结论与证据</h2>
                    <span>{filtered.length} 项</span>
                  </div>
                  <div className="ft-evidence-controls">
                    <label className="ft-search">
                      <Search size={16} />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索结论、证据或编号"
                        aria-label="搜索证据"
                      />
                    </label>
                    <select
                      aria-label="按证据类别筛选"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">全部类别</option>
                      <option value="fact">事实核对</option>
                      <option value="derived">计算推导</option>
                      <option value="scope">口径说明</option>
                      <option value="open">待补证</option>
                    </select>
                  </div>
                  <div className="ft-evidence-list">
                    {filtered.map((c) => (
                      <button
                        key={c.id}
                        className={`ft-evidence-card ${selected === c.id ? 'is-selected' : ''}`}
                        onClick={() => selectClaim(c)}
                      >
                        <div>
                          <span>{c.id}</span>
                          <span
                            className={`ft-tag ${c.kind === 'open' ? 'ft-tag-amber' : ''}`}
                          >
                            {c.label}
                          </span>
                        </div>
                        <h3>{c.title}</h3>
                        <p>{c.summary}</p>
                        <small>
                          {c.sourceIds.join(' / ') || '尚无足够来源'}
                          <ChevronRight size={14} />
                        </small>
                      </button>
                    ))}
                    {filtered.length === 0 && (
                      <div className="ft-empty">
                        <Search size={24} />
                        <h3>没有匹配的证据</h3>
                        <p>试试“收入”“口径”，或清除筛选。</p>
                        <button
                          className="ft-button"
                          onClick={() => {
                            setQuery('');
                            setFilter('all');
                          }}
                        >
                          清除筛选
                        </button>
                      </div>
                    )}
                  </div>
                </section>
                <EvidenceDetail claim={claim} />
              </div>
            )}

            {view === 'workflow' && (
              <section className="ft-panel ft-workflow-panel">
                <div className="ft-panel-heading">
                  <h2>从研究问题到可追溯草稿</h2>
                  <span className="ft-tag">流程设计示例</span>
                </div>
                <p className="ft-workflow-intro">
                  点击步骤查看输入、核对规则与预期产物。这是本案例的研究设计，真实工具执行轨迹待接入。
                </p>
                <div className="ft-workflow-grid">
                  <div className="ft-stage-list">
                    {stages.map((stage, index) => (
                      <button
                        className={activeStage === index ? 'is-active' : ''}
                        key={stage.title}
                        onClick={() => setActiveStage(index)}
                      >
                        <span>{index + 1}</span>
                        <div>
                          <strong>{stage.title}</strong>
                          <small>{stage.action}</small>
                        </div>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                  <article className="ft-stage-detail">
                    <span className="ft-tag">
                      步骤 {activeStage + 1} / {stages.length}
                    </span>
                    <h3>{stages[activeStage].title}</h3>
                    <p>{stages[activeStage].detail}</p>
                    <div>
                      <FileCheck2 size={20} />
                      <span>
                        <small>预期产物</small>
                        <strong>{stages[activeStage].output}</strong>
                      </span>
                    </div>
                    {activeStage === 2 && (
                      <div className="ft-scope-comparison">
                        <span>
                          全年 · 已报告<b>≈ 16%</b>
                        </span>
                        <span>
                          第四财季 · 已报告<b>≈ 15%</b>
                        </span>
                        <span>
                          全年 · 固定汇率<b>≈ 15%</b>
                        </span>
                      </div>
                    )}
                    <p className="ft-stage-footnote">
                      期间或口径缺失时返回取证；补证预算耗尽后保留待确认项。
                    </p>
                  </article>
                </div>
              </section>
            )}

            {view === 'report' && (
              <div className="ft-report-grid">
                <article className="ft-panel ft-report">
                  <div className="ft-panel-heading">
                    <h2>研究草稿</h2>
                    <span className="ft-tag">公开案例</span>
                  </div>
                  <div className="ft-report-body">
                    <div className="ft-report-meta">
                      Microsoft · FY2024 / FY2023 · 2026-09-30 整理
                    </div>
                    <h2>收入增长与分部增量核对</h2>
                    <p className="ft-report-lead">
                      基于原始披露口径，核对全年增长、分部增量和公告中的百分比差异。
                    </p>
                    {claims.map((c) => (
                      <section key={c.id}>
                        <span
                          className={`ft-tag ${c.kind === 'open' ? 'ft-tag-amber' : ''}`}
                        >
                          {c.label}
                        </span>
                        <h3>{c.title}</h3>
                        <p>{c.summary}</p>
                        {c.formula && <code>{c.formula}</code>}
                        <div className="ft-report-citations">
                          {c.sourceIds.map((id) => {
                            const s = sources.find((s) => s.id === id)!;
                            return (
                              <a
                                key={id}
                                href={s.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                [{id}] {s.title}
                                <ExternalLink size={12} />
                              </a>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                    <p className="ft-report-boundary">
                      资料来自同一公司的三份公开披露。此草稿用于展示，不代表
                      Agent 运行产物；AI 归因仍待补证。
                    </p>
                  </div>
                </article>
                <aside className="ft-panel ft-review">
                  <FileCheck2 size={28} />
                  <h2>人工复核</h2>
                  <p>确认来源、期间、单位与公式，并保留未解决的判断。</p>
                  <ul>
                    <li>
                      <Check size={15} />
                      比较期间均为十二个月
                    </li>
                    <li>
                      <Check size={15} />
                      金额统一为百万美元
                    </li>
                    <li>
                      <Check size={15} />
                      原始分部口径明确
                    </li>
                    <li>
                      <CircleHelp size={15} />
                      AI 增长归因仍待补证
                    </li>
                  </ul>
                  <button
                    aria-pressed={reviewed}
                    className={`ft-button ${reviewed ? '' : 'ft-button-primary'}`}
                    onClick={() => setReviewed(!reviewed)}
                  >
                    {reviewed ? <Check size={16} /> : <FileCheck2 size={16} />}
                    {reviewed ? '取消本次复核标记' : '标记本次演示已复核'}
                  </button>
                  <span className="ft-review-feedback" role="status">
                    {reviewed
                      ? '本次页面已标记；待补证项仍保留。'
                      : '复核标记仅保存在本次页面，刷新后重置。'}
                  </span>
                  <button className="ft-button" onClick={download}>
                    <Download size={16} />
                    下载 Markdown
                  </button>
                </aside>
              </div>
            )}
          </div>
          <footer className="ft-footer">
            <span>FinTrace · 让研究结论可追溯</span>
            <span>公开数据案例 / 2026-09-30 整理</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function EvidenceDetail({ claim }: { claim: Claim }) {
  return (
    <aside
      className="ft-panel ft-detail"
      aria-label="选中的证据详情"
      aria-live="polite"
    >
      <div className="ft-panel-heading">
        <h2>证据详情</h2>
        <span>{claim.id}</span>
      </div>
      <div className="ft-detail-body">
        <span
          className={`ft-tag ${claim.kind === 'open' ? 'ft-tag-amber' : ''}`}
        >
          {claim.label}
        </span>
        <h3>{claim.title}</h3>
        <p>{claim.summary}</p>
        {claim.formula && (
          <div className="ft-formula">
            <span>计算依据</span>
            <code>{claim.formula}</code>
          </div>
        )}
        <div className="ft-detail-scope">
          <span>采用口径</span>
          <p>{claim.scope}</p>
        </div>
        <div className="ft-source-heading">
          来源定位<span>{claim.sourceIds.length} 份披露</span>
        </div>
        {claim.sourceIds.map((id) => {
          const source = sources.find((s) => s.id === id)!;
          return (
            <a
              className="ft-source"
              key={id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="ft-source-icon">
                <FileText size={17} />
              </span>
              <div>
                <small>
                  {source.id} · {source.type}
                </small>
                <strong>{source.title}</strong>
                <p>{source.location}</p>
              </div>
              <ArrowUpRight size={14} />
            </a>
          );
        })}
        {claim.sourceIds.length === 0 && (
          <div className="ft-source-missing">
            <CircleHelp size={20} />
            <p>尚无足够披露支持该判断。需要补充可量化的 AI 收入依据。</p>
          </div>
        )}
        <div className="ft-detail-footnote">
          <ShieldCheck size={15} />
          <p>人工整理的案例资料；来源链接用于回溯原文，未执行实时拉取。</p>
        </div>
      </div>
    </aside>
  );
}
