export function DopplerReadiness({steps}:{steps:{id:string;label:string;ready:boolean;detail:string}[]}){
  const remaining=steps.filter(step=>!step.ready);
  return <section className="dc-readiness" aria-label="Search readiness"><h2>SYSTEM READY <span>{steps.length-remaining.length} / {steps.length} CHECKS</span></h2><ol>{steps.map(step=><li key={step.id} data-ready={step.ready}><i className={`dc-led ${step.ready?'is-ready':''}`} aria-hidden="true"><span className="dc-lamp-filament"/></i><div><strong>{step.label}</strong><span className="dc-led-state">{step.ready?'READY':'WAITING'}</span></div></li>)}</ol></section>;
}
