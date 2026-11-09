import {useEffect, useRef, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import './doppler-launch-switch.css';

export function DopplerLaunchSwitch({disabled,busy,searching,activate}:{disabled:boolean;busy:boolean;searching:boolean;activate:()=>void}) {
  const [open,setOpen]=useState(false),[pressed,setPressed]=useState(false);
  const cover=useRef<HTMLButtonElement>(null);
  const animation=useRef<Animation|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const latest=useRef({disabled,busy,activate});latest.current={disabled,busy,activate};
  const available=!disabled&&!busy,raised=open&&available;
  function close(){clearTimeout(timer.current);setOpen(false);setPressed(false);}
  useEffect(()=>{if(!available){clearTimeout(timer.current);setOpen(false);setPressed(false);}},[available]);
  useEffect(()=>()=>{clearTimeout(timer.current);animation.current?.cancel();},[]);
  function lift(){
    animation.current?.cancel();
    if(raised){close();return;}
    if(available){setOpen(true);return;}
    if(cover.current&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      animation.current=cover.current.animate([
        {transform:'translateZ(6px) rotateX(0deg)'},
        {transform:'translateZ(6px) rotateX(5deg)',offset:.2},
        {transform:'translateZ(6px) rotateX(1deg)',offset:.4},
        {transform:'translateZ(6px) rotateX(3deg)',offset:.6},
        {transform:'translateZ(6px) rotateX(0deg)'}
      ],{duration:440,easing:'ease-out'});
    }
  }
  function launch(){
    if(!raised||!available||pressed)return;
    setPressed(true);
    timer.current=setTimeout(()=>{setOpen(false);setPressed(false);if(!latest.current.disabled&&!latest.current.busy)latest.current.activate();},180);
  }
  return <div className={`dc-switch ${raised?'is-open':''} ${pressed?'is-depressed':''} ${available?'is-available':'is-locked'}`} onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();close();cover.current?.focus();}}}>
    <div className="dc-switch-mount">
      <i className="dc-switch-screw" aria-hidden="true"/><i className="dc-switch-screw" aria-hidden="true"/>
      <button id="dc-go-switch" type="button" className="dc-go dc-switch-go" aria-label={searching?'Searching':busy?'Preparing':'GO'} disabled={!raised||!available||pressed} onClick={launch}>
        <span className="dc-push-cap"><span className="dc-push-label">{busy?<LoaderCircle size={19} className="spin"/>:'GO'}</span></span>
      </button>
      {busy&&<span className="dc-switch-running" role="status">{searching?'SEARCHING':'PREPARING'}</span>}
      <div className="dc-switch-hinge" aria-hidden="true"/>
      <button ref={cover} type="button" className="dc-switch-cover" aria-label={raised?'Close glass cover':'Open glass cover'} aria-expanded={raised} aria-controls="dc-go-switch" title={!available?'Complete all SYSTEM READY checks to release the cover':raised?'Close cover':'Lift cover'} onClick={lift}>
        <span className="dc-cover-pane" aria-hidden="true"/><span className="dc-cover-wall is-left" aria-hidden="true"/><span className="dc-cover-wall is-right" aria-hidden="true"/><span className="dc-cover-wall is-front" aria-hidden="true"/><span className="dc-cover-wall is-back" aria-hidden="true"/>
        <span className="dc-cover-rim" aria-hidden="true"/><span className="dc-cover-grip" aria-hidden="true"/><span className="dc-cover-engraving" aria-hidden="true">{available?'LIFT':'LOCKED'}</span>
      </button>
    </div>
  </div>;
}
