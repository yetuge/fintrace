import { useState } from 'react';
import { Bug, ExternalLink, Github, Workflow } from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">FinTrace</h2>
        <p className="text-sm text-muted-foreground">
          基于 Pi Runtime 的多源金融研究 Agent 工作台
        </p>
        <p className="mt-1 text-xs text-muted-foreground">版本 1.0.0</p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href="https://github.com/yetuge/fintrace"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary inline-flex items-center gap-1"
          >
            yetuge/fintrace <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <p className="text-sm text-muted-foreground">维护者：yetuge</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowBugReport(true)}
        >
          <Bug className="w-3.5 h-3.5" />
          报告问题
        </Button>
      </div>
      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />
      <hr className="border-border" />
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Workflow className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">研究与执行</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Pi Runtime 负责模型交互、工具调用与会话执行；FinTrace
          组织工作区、研究资料、记忆、能力配置和任务调度。公开财报案例展示来源核对、证据关联、口径解释与带引用的研究草稿。
        </p>
      </div>
    </div>
  );
}
