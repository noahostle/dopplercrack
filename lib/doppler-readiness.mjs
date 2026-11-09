export function recordingStartError(range){
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  const time=value=>/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value||'');
  if(!date(range.dateFrom)||!time(range.timeFrom))return 'Enter the recording start date and time.';
  if(range.dateFrom<'2000-01-01')return 'Recording dates must be in 2000 or later.';
  if(range.mode==='range'){
    if(!date(range.dateTo)||!time(range.timeTo))return 'Enter the last date and latest possible start time.';
    if(range.dateTo<range.dateFrom||Date.parse(range.dateTo)-Date.parse(range.dateFrom)>=366*86400000)return 'Select an ordered date range of up to 366 days.';
    if(!Number.isFinite(range.stepSeconds)||range.stepSeconds<.5||range.stepSeconds>3600)return 'Choose a valid start-time interval.';
  }
  try{new Intl.DateTimeFormat('en',{timeZone:range.timeZone});}catch{return 'Choose a recording timezone.';}
  return '';
}
export function readinessSteps(job,countries,range,health,pending=false){
  const timeError=recordingStartError(range),stopped=['cancelled','error'].includes(job?.state),signal=!stopped&&!!job?.events?.length&&job.detectorVersion===4;
  return [
    {id:'recording',label:'Recording',ready:!!job?.media,detail:job?.media?job.name:pending?'Loading recording…':'Upload a file or load a YouTube link.'},
    {id:'portion',label:'Audio analysis',ready:!!job?.duration&&!!job?.segment,detail:job?.duration?`${job.duration.toFixed(1)} seconds analyzed.`:job?.state==='selecting'?'Choose timestamps, then press DOWNLOAD & ANALYZE AUDIO.':job?.stage||'Add a recording to prepare its audio.'},
    {id:'signal',label:'Doppler signal',ready:signal,detail:signal?`${job.events.length} independent tone event${job.events.length===1?'':'s'} found.`:stopped?job.error||'Processing was cancelled. Reload the recording or analyze another portion.':job?.state==='ready'?'No coherent moving tone found. Choose another portion with clearer aircraft audio.':'Waiting for audio analysis.'},
    {id:'countries',label:'Search area',ready:countries.length>0,detail:countries.length?`${countries.length} countries or territories selected.`:''},
    {id:'clock',label:'Start time',ready:!timeError,detail:timeError||(range.mode==='exact'?'Exact recording start.':`Possible starts every ${range.stepSeconds} seconds on each selected day.`)},
    {id:'engine',label:'Engine',ready:!!health?.available,detail:health?.available?'Local C worker available.':health?.note||'Connecting to the local worker…'},
  ];
}
