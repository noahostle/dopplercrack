/* Automatic discovery on the SAME high-resolution pixels used for scoring.
 * Integrate local tone evidence over time; allow masked frames and partial
 * passes. A straight-line fit is a broad search prior, not an aircraft test.
 * Thresholds are engineering choices, not calibrated detection probabilities.
 */
typedef struct {
  Event event;
  double cpa, speed, slant, rest, error, contrast, continuity, quality, coherence;
  double vmin, vmax, rmin, rmax, fmin, fmax, tolerance;
  int merged_candidates;
} Discovery;
static Discovery discoveries[256];
static int discovery_count, discovery_rejected, rejected_support, rejected_motion, rejected_shape;
static double spectrum_guard(const Spectrogram *s){return s->duration<16?.5:s->duration<32?1:2;}

static double local_contrast(const Spectrogram *s, int t, int f) {
  // Compare to both neighbouring bands, excluding the Hann main lobe. This
  // removes broadband speech/wind bursts that a global noise mean admitted.
  double background[40]; int n=0;
  const unsigned char *row=s->values+(size_t)t*s->nf;
  // A four-second window spreads a fast chirp across several Hz. Sampling
  // directly beside it would mistake the same signal for its noise floor.
  for(int d=-96;d<=96;d+=4)if(abs(d)>=32&&f+d>=0&&f+d<(int)s->nf)
    background[n++]=row[f+d]/s->scale;
  if(n<12)return 0;
  qsort(background,n,sizeof(double),double_compare);
  return row[f]/s->scale-background[n/2];
}
static void fit_discovery(Discovery *d) {
  Event *e=&d->event;double start=e->t[0],end=e->t[e->n-1],best=1e30;
  double padding=fmin(60,fmax(8,(end-start)*.5)),low=start-padding,high=end+padding;
  for(double v=30;v<=230;v+=20)for(double r=200;r<=10000;r*=1.65)
    for(int j=0;j<=16;j++){
      double cp=low+(high-low)*j/16,rest;
      double loss=ideal_loss(e,cp,v,r,340.39,&rest);
      if(loss<best){best=loss;d->cpa=cp;d->speed=v;d->slant=r;d->rest=rest;}
    }
  double dc=(end-start)/5,dv=30,dr=d->slant*.5;
  for(int round=0;round<14;round++){
    for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
      double cp=d->cpa+(axis==0?sign*dc:0),v=d->speed+(axis==1?sign*dv:0),r=d->slant+(axis==2?sign*dr:0),rest;
      if(cp<low||cp>high||v<15||v>245||r<100||r>10000)continue;
      double loss=ideal_loss(e,cp,v,r,340.39,&rest);
      if(loss<best){best=loss;d->cpa=cp;d->speed=v;d->slant=r;d->rest=rest;}
    }dc*=.65;dv*=.65;dr*=.65;
  }
  d->error=best;
  // Profile many alternative straight-line shapes rather than treating a
  // single underdetermined fit as an exact speed/distance measurement.
  d->vmin=d->vmax=d->speed;d->rmin=d->rmax=d->slant;
  d->fmin=d->fmax=d->rest;double cpmin=d->cpa,cpmax=d->cpa;
  double acceptable=best*1.5+fmax(.5,d->rest*.005);
  for(double v=20;v<=240;v+=10)for(double r=100;r<=10000;r*=1.35)
    for(int j=0;j<=24;j++){
      double cp=low+(high-low)*j/24,rest;
      if(ideal_loss(e,cp,v,r,340.39,&rest)>acceptable)continue;
      d->vmin=fmin(d->vmin,v);d->vmax=fmax(d->vmax,v);
      d->rmin=fmin(d->rmin,r);d->rmax=fmax(d->rmax,r);
      d->fmin=fmin(d->fmin,rest);d->fmax=fmax(d->fmax,rest);
      cpmin=fmin(cpmin,cp);cpmax=fmax(cpmax,cp);
    }
  // Extra allowance for non-linear real trajectories and the finite grid.
  d->vmin=fmax(10,d->vmin*.75);d->vmax=fmin(245,d->vmax*1.3);
  d->rmin=fmax(50,d->rmin*.6);d->rmax=fmin(10000,d->rmax*1.5);
  d->fmin=fmax(15,d->fmin-d->rest*.08);d->fmax=fmin(900,d->fmax+d->rest*.08);
  d->tolerance=fmax(5,fmax(d->cpa-cpmin,cpmax-d->cpa)+4);
}
static double curve_evidence(Discovery *d){
  // Verify accumulated energy on the fitted curve against equally pooled,
  // frequency-shifted control curves. Greedily choosing a peak in every noisy
  // frame creates a spurious ridge; it does not brighten one coherent curve.
  double sums[9]={0},width=fmax(.375,d->rest*.002);
  int counts[9]={0},supported=0;
  for(double t=d->event.t[0];t<=d->event.t[d->event.n-1];t+=.5){
    double hz=d->rest*ideal_factor(t,d->cpa,d->speed,d->slant,340.39);
    // A four-second FFT smears a fast chirp by roughly +/-2*f'(t) Hz.
    // Place controls outside that lobe, not inside the signal being measured.
    double slope=fabs(d->rest*(ideal_factor(t+.25,d->cpa,d->speed,d->slant,340.39)-ideal_factor(t-.25,d->cpa,d->speed,d->slant,340.39)))/.5;
    double separation=fmax(4*width+2,2*slope+2);
    double frame[9];
    for(int k=0;k<9;k++){
      double offset=k?((k+1)/2)*separation*(k%2?1:-1):0,value=-1;
      for(int p=-2;p<=2;p++){
        double b=brightness(t,hz+offset+width*p/2);
        if(isfinite(b)&&b>value)value=b;
      }
      frame[k]=value;
      if(value>=0){sums[k]+=value;counts[k]++;}
    }
    double noise=0;int valid=0;for(int k=1;k<9;k++)if(frame[k]>=0){noise+=frame[k];valid++;}
    if(valid&&frame[0]>noise/valid+2)supported++;
  }
  double controls[8],mean=0,maximum=0;int n=0;
  for(int k=1;k<9;k++)if(counts[k]){controls[n]=sums[k]/counts[k];mean+=controls[n];maximum=fmax(maximum,controls[n++]);}
  if(n<4||!counts[0])return 0;
  mean/=n;
  double excess=sums[0]/counts[0]-mean;
  double flat=0;
  for(int f=0;f<12;f++){
    double time=d->event.t[0]+(d->event.t[d->event.n-1]-d->event.t[0])*f/11;
    double hz=d->rest*ideal_factor(time,d->cpa,d->speed,d->slant,340.39),sum=0;int frames=0;
    for(double t=d->event.t[0];t<=d->event.t[d->event.n-1];t+=.5){
      double best=0;for(int p=-2;p<=2;p++){double b=brightness(t,hz+width*p/2);if(isfinite(b)&&b>best)best=b;}
      sum+=best;frames++;
    }
    if(frames)flat=fmax(flat,sum/frames);
  }
  if(getenv("DOPPLER_DISCOVERY_DEBUG"))fprintf(stderr,"coherence f %.2f curve %.2f excess %.2f strongest-control %.2f flat %.2f\n",d->rest,sums[0]/counts[0],excess,maximum,flat);
  d->continuity=(double)supported/counts[0];
  d->contrast=excess;
  // Shifted curves are not Gaussian noise samples: a chirp's sidelobes make
  // them asymmetric. Compare directly with the strongest control instead of
  // turning that asymmetry into a variance penalty against clean flyovers.
  return supported>=8&&supported>=counts[0]*.45&&excess>=2.5&&sums[0]/counts[0]>maximum+.5&&sums[0]/counts[0]>flat+1?excess:0;
}
static void refine_ridge(Discovery *d){
  // Viterbi refinement considers a sequence of pixels, not just the loudest
  // next peak. Offset states follow the fitted curve, so brief masking can be
  // crossed without jumping to unrelated hum or throwing away the whole tone.
  Spectrogram *s=&observed_spectrum;Event *e=&d->event;
  int first=(int)lround(e->t[0]/s->dt),last=(int)lround(e->t[e->n-1]/s->dt),nt=last-first+1;
  int radius=(int)ceil(fmin(64,fmax(5,d->rest*.16))/s->df),nb=2*radius+1;
  int step=(int)ceil((1+d->rest*.01)*s->dt/s->df);
  double *prior=allocate(nb,sizeof(double)),*next=allocate(nb,sizeof(double));
  uint16_t *back=allocate((size_t)nt*nb,sizeof(uint16_t));
  int *path=allocate(nt,sizeof(int));
  for(int t=0;t<nt;t++){
    double hz=d->rest*ideal_factor((first+t)*s->dt,d->cpa,d->speed,d->slant,340.39);
    for(int f=0;f<nb;f++){
      double best=t?-1e30:0;int from=f;
      if(t)for(int k=f-step>0?f-step:0;k<=f+step&&k<nb;k++){
        double delta=f-k,score=prior[k]-.15*delta*delta;
        if(score>best){best=score;from=k;}
      }
      double value=brightness((first+t)*s->dt,hz+(f-radius)*s->df);
      // Keep peak contrast: clipping dB flattens a clean tone and its FFT
      // sidelobes into a plateau, letting the path drift off the ridge.
      next[f]=best+(isfinite(value)?value:-100);
      back[(size_t)t*nb+f]=(uint16_t)from;
    }
    double *swap=prior;prior=next;next=swap;
  }
  int best=0;for(int f=1;f<nb;f++)if(prior[f]>prior[best])best=f;
  for(int t=nt-1;t>=0;t--){path[t]=best;best=back[(size_t)t*nb+best];}
  e->n=nt<64?nt:64;
  for(int i=0;i<e->n;i++){
    int t=i*(nt-1)/(e->n-1);double time=(first+t)*s->dt;
    double hz=d->rest*ideal_factor(time,d->cpa,d->speed,d->slant,340.39)+(path[t]-radius)*s->df;
    int f=(int)lround((hz-s->f0)/s->df);double contrast=f>0&&f<(int)s->nf-1?local_contrast(s,first+t,f):0;
    contrast=fmax(0,contrast);
    e->t[i]=time;e->f[i]=fmax(15,fmin(900,hz));e->w[i]=fmax(.05,fmin(1,contrast*contrast/144));
  }
  free(prior);free(next);free(back);free(path);
  fit_discovery(d);
}
static double tone_frequency(const Event *e,double t){
  int i=0;while(i+1<e->n&&e->t[i+1]<t)i++;
  if(i+1==e->n)return e->f[i];
  return e->f[i]+(e->f[i+1]-e->f[i])*(t-e->t[i])/(e->t[i+1]-e->t[i]);
}
static int harmonic_match(const Discovery *a,const Discovery *b){
  double start=fmax(a->event.t[0],b->event.t[0]),end=fmin(a->event.t[a->event.n-1],b->event.t[b->event.n-1]);
  double duration=fmin(a->event.t[a->event.n-1]-a->event.t[0],b->event.t[b->event.n-1]-b->event.t[0]);
  // Masking or a change in RPM may split one continuous track. Rejoin short
  // gaps only when the measured endpoints connect in both pitch and slope.
  if(end<start&&start-end<=8){
    const Event *left=a->event.t[0]<b->event.t[0]?&a->event:&b->event,*right=left==&a->event?&b->event:&a->event;
    double dt=right->t[0]-left->t[left->n-1],span=fmin(3,duration/2);
    double slope=(left->f[left->n-1]-tone_frequency(left,left->t[left->n-1]-span))/span;
    double next=(tone_frequency(right,right->t[0]+span)-right->f[0])/span;
    return fabs(left->f[left->n-1]+.5*(slope+next)*dt-right->f[0])<fmax(1,right->f[0]*.015)&&fabs(slope-next)<fmax(1,right->f[0]*.01);
  }
  if(end-start<fmin(6,duration*.75))return 0;
  // Two observed harmonics can be 3:2 or 4:3; neither has to be the
  // fundamental. Compare measured tracks, not biased partial-curve f0 fits.
  double ratios[12];for(int i=0;i<12;i++){double t=start+(end-start)*i/11;ratios[i]=tone_frequency(&a->event,t)/tone_frequency(&b->event,t);if(ratios[i]<1)ratios[i]=1/ratios[i];}
  double sorted[12];memcpy(sorted,ratios,sizeof sorted);qsort(sorted,12,sizeof(double),double_compare);
  double options[]={1,2,3,4,5,6,1.5,2.5,4.0/3,5.0/3},harmonic=0;
  for(int i=0;i<10;i++)if(fabs(sorted[6]-options[i])<options[i]*.02){harmonic=options[i];break;}
  if(!harmonic)return 0;
  int disagree=0;
  for(int i=0;i<12;i++){
    double t=start+(end-start)*i/11,lo=fmax(start,t-1),hi=fmin(end,t+1);
    double slope=fabs(tone_frequency(&a->event,hi)-tone_frequency(&a->event,lo))/fmax(.5,hi-lo);
    double tolerance=fmax(.025,2*slope/fmax(20,tone_frequency(&a->event,t)));
    if(fabs(ratios[i]-harmonic)>harmonic*tolerance)disagree++;
  }
  if(disagree>2)return 0;
  return 1;
}
static int independent_energy(const Discovery *d,const Discovery *accepted,int count){
  if(!count)return 1;
  double energy=0,remaining=0,width=fmax(.375,d->rest*.002);
  const double ratios[]={1,2,3,4,.5,1.5,2.5,1.0/3,2.0/3,4.0/3,.25,.75};
  for(double t=d->event.t[0];t<=d->event.t[d->event.n-1];t+=.5){
    double hz=d->rest*ideal_factor(t,d->cpa,d->speed,d->slant,340.39);
    for(int p=-2;p<=2;p++){
      double f=hz+width*p/2,b=brightness(t,f);if(!isfinite(b))continue;
      double value=fmax(0,b-2.5);energy+=value;int claimed=0;
      for(int a=0;a<count&&!claimed;a++){
        const Event *e=&accepted[a].event;if(t<e->t[0]||t>e->t[e->n-1])continue;
        double base=tone_frequency(e,t),before=fmax(e->t[0],t-.5),after=fmin(e->t[e->n-1],t+.5);
        double slope=fabs(tone_frequency(e,after)-tone_frequency(e,before))/fmax(.5,after-before);
        for(int h=0;h<12;h++)if(fabs(f-base*ratios[h])<ratios[h]*(1+2*slope)){claimed=1;break;}
      }
      if(!claimed)remaining+=value;
    }
  }
  // Explain away energy already attributed to a stronger pass. A different
  // template touching the same bright ridge is not an additional aircraft.
  return energy>0&&remaining/energy>.75;
}
static void join_tone(Discovery *target,const Discovery *other){
  // Merge overlapping fragments of the same frequency track before association.
  // Different harmonics still count as ONE flyover, never independent aircraft.
  target->merged_candidates+=other->merged_candidates;
  double overlapFrom=fmax(target->event.t[0],other->event.t[0]),overlapTo=fmin(target->event.t[target->event.n-1],other->event.t[other->event.n-1]);
  double midpoint=(overlapFrom+overlapTo)/2;
  if(fabs(tone_frequency(&target->event,midpoint)/tone_frequency(&other->event,midpoint)-1)>.04)return;
  Event a=target->event,b=other->event,merged={.n=64};
  double from=fmin(a.t[0],b.t[0]),to=fmax(a.t[a.n-1],b.t[b.n-1]);
  for(int i=0;i<64;i++){
    double t=from+(to-from)*i/63;
    int ina=t>=a.t[0]&&t<=a.t[a.n-1],inb=t>=b.t[0]&&t<=b.t[b.n-1];
    merged.t[i]=t;merged.w[i]=1;
    double fa=tone_frequency(&a,t),fb=tone_frequency(&b,t);
    merged.f[i]=ina&&inb?(brightness(t,fa)>=brightness(t,fb)?fa:fb):ina?fa:fb;
  }
  Discovery combined=*target;combined.event=merged;fit_discovery(&combined);
  if(combined.error<=fmax(.75,combined.rest*.02)&&combined.tolerance<=240){combined.coherence=curve_evidence(&combined);if(combined.coherence){combined.quality=combined.coherence*(to-from)/(1+combined.error/fmax(1,combined.rest*.01));if(combined.quality>=target->quality)*target=combined;}}
}
#define DISCOVERY_LOG_STEP .004
static const double template_speeds[]={25,40,60,85,115,150,200};
static const double template_taus[]={3,6,10,16,25,40,65,100};
typedef struct{Spectrogram *s;float *image,*scores;uint16_t *shapes;int nf,nc;double first,step;atomic_int next;} TemplateScan;
static void *template_worker(void *argument){
  TemplateScan *scan=argument;Spectrogram *s=scan->s;int ci;
  while((ci=atomic_fetch_add(&scan->next,1))<scan->nc){
    double cp=scan->first+ci*scan->step;
    for(int vi=0;vi<7;vi++)for(int ri=0;ri<8;ri++){
      double v=template_speeds[vi],r=v*template_taus[ri];if(r>10000)continue;
      double half=fmin(60,fmax(6,1.5*template_taus[ri]));
      double guard=spectrum_guard(s),from=fmax(guard,cp-half),to=fmin(s->duration-guard,cp+half);
      if(to-from<6)continue;
      int n=(int)((to-from)/s->dt)+1;if(n>33)n=33;
      int shifts[33],rows[33],minshift=0,maxshift=0;double maxslope=0;
      for(int i=0;i<n;i++){
        double t=from+(to-from)*i/(n-1),factor=ideal_factor(t,cp,v,r,340.39);
        shifts[i]=(int)lround(log(factor)/DISCOVERY_LOG_STEP);rows[i]=(int)lround(t/s->dt);
        if(shifts[i]<minshift)minshift=shifts[i];
        if(shifts[i]>maxshift)maxshift=shifts[i];
        double slope=fabs(log(ideal_factor(t+.25,cp,v,r,340.39)/ideal_factor(t-.25,cp,v,r,340.39)))/.5;
        maxslope=fmax(maxslope,slope);
      }
      if(maxshift-minshift<3)continue;
      int control=(int)ceil(fmax(.035,2*maxslope+.01)/DISCOVERY_LOG_STEP);
      for(int f=-minshift;f<scan->nf-maxshift;f++){
        double sum=0;for(int i=0;i<n;i++)sum+=scan->image[(size_t)rows[i]*scan->nf+f+shifts[i]];
        double mean=sum/n;if(mean<2.5)continue;
        double flat=0,side=0;int sides=0;
        for(int i=0;i<n;i++){
          const float *row=scan->image+(size_t)rows[i]*scan->nf;int at=f+shifts[i];flat+=row[f];
          if(at-control>=0){side+=row[at-control];sides++;}if(at+control<scan->nf){side+=row[at+control];sides++;}
        }
        if(!sides||mean-flat/n<1)continue;
        double excess=mean-side/sides;
        if(excess<2.5)continue;
        double score=excess*sqrt((to-from)/4);
        size_t at=(size_t)ci*scan->nf+f;
        if(score>scan->scores[at]){scan->scores[at]=(float)score;scan->shapes[at]=(uint16_t)(vi*8+ri);}
      }
    }
  }
  return NULL;
}
typedef struct{double score;int ci,f,shape;} TemplatePeak;
static int template_compare(const void *a,const void *b){double d=((const TemplatePeak*)a)->score-((const TemplatePeak*)b)->score;return d>0?-1:d<0;}
static void scan_templates(Spectrogram *s){
  // On a log-frequency axis f0 is a translation. A small bank of delayed
  // constant-speed shapes scores coherent sequences without needing a bright
  // pixel in every frame. The final scorer still uses the unmodified spectrum.
  TemplateScan scan={.s=s,.nf=(int)(log(800.0/20)/DISCOVERY_LOG_STEP)+1,.first=-60,.step=s->duration<24?1:3};
  scan.nc=(int)((s->duration+120)/scan.step)+1;atomic_init(&scan.next,0);
  scan.image=allocate((size_t)s->nt*scan.nf,sizeof(float));scan.scores=allocate((size_t)scan.nc*scan.nf,sizeof(float));scan.shapes=allocate((size_t)scan.nc*scan.nf,sizeof(uint16_t));
  double *column=allocate(s->nt,sizeof(double));
  for(int f=0;f<scan.nf;f++){
    double hz=20*exp(f*DISCOVERY_LOG_STEP),width=fmax(.375,hz*.003);
    int low=(int)floor((hz-width-s->f0)/s->df),high=(int)ceil((hz+width-s->f0)/s->df);
    for(uint32_t t=0;t<s->nt;t++){
      const unsigned char *row=s->values+(size_t)t*s->nf;double best=0;
      for(int k=low>0?low:0;k<=high&&k<(int)s->nf;k++)if(row[k]/s->scale>best)best=row[k]/s->scale;
      scan.image[(size_t)t*scan.nf+f]=(float)best;column[t]=best;
    }
    qsort(column,s->nt,sizeof(double),double_compare);double baseline=column[s->nt/2];
    for(uint32_t t=0;t<s->nt;t++)scan.image[(size_t)t*scan.nf+f]-=(float)baseline;
  }
  free(column);
  long cores=sysconf(_SC_NPROCESSORS_ONLN);int threads=(int)(cores<1?1:cores>8?8:cores);
  pthread_t workers[8];for(int i=0;i<threads;i++)if(pthread_create(&workers[i],NULL,template_worker,&scan))fail("Cannot start discovery worker");
  for(int i=0;i<threads;i++)pthread_join(workers[i],NULL);
  TemplatePeak *peaks=allocate((size_t)scan.nc*scan.nf,sizeof(TemplatePeak));int count=0;
  for(int t=0;t<scan.nc;t++)for(int f=0;f<scan.nf;f++){
    size_t at=(size_t)t*scan.nf+f;double score=scan.scores[at];if(score<8)continue;
    int maximum=1;
    for(int a=t-2;a<=t+2&&maximum;a++)if(a>=0&&a<scan.nc)for(int b=f-5;b<=f+5;b++)if(b>=0&&b<scan.nf){size_t other=(size_t)a*scan.nf+b;if(scan.scores[other]>score||(scan.scores[other]==score&&other<at)){maximum=0;break;}}
    if(maximum)peaks[count++]=(TemplatePeak){score,t,f,scan.shapes[at]};
  }
  qsort(peaks,count,sizeof(TemplatePeak),template_compare);
  int limit=count<96?count:96;
  for(int p=0;p<limit;p++){
    TemplatePeak *peak=&peaks[p];Discovery d={0};
    d.cpa=scan.first+peak->ci*scan.step;d.rest=20*exp(peak->f*DISCOVERY_LOG_STEP);d.speed=template_speeds[peak->shape/8];d.slant=d.speed*template_taus[peak->shape%8];
    double half=fmin(60,fmax(6,1.5*template_taus[peak->shape%8]));
    double guard=spectrum_guard(s),from=fmax(guard,d.cpa-half),to=fmin(s->duration-guard,d.cpa+half);
    d.event.n=2;d.event.t[0]=from;d.event.t[1]=to;
    refine_ridge(&d);
    double drop=d.event.f[0]-d.event.f[d.event.n-1];
    if(drop<fmax(1.5,d.rest*.012)){discovery_rejected++;rejected_motion++;continue;}
    if(d.error>fmax(.75,d.rest*.02)||d.error>drop*.22||d.tolerance>240||d.rest<15||d.rest>900){discovery_rejected++;rejected_shape++;continue;}
    d.coherence=curve_evidence(&d);if(!d.coherence){discovery_rejected++;rejected_support++;continue;}
    d.merged_candidates=1;d.quality=d.coherence*(to-from)/(1+d.error/fmax(1,d.rest*.01));
    if(discovery_count<256)discoveries[discovery_count++]=d;
  }
  free(peaks);free(scan.image);free(scan.scores);free(scan.shapes);
}
static void discover_spectrum(const char *path,const char *output){
  load_spectrogram(path);Spectrogram *s=&observed_spectrum;
  discovery_count=discovery_rejected=rejected_support=rejected_motion=rejected_shape=0;
  scan_templates(s);
  if(getenv("DOPPLER_DISCOVERY_DEBUG"))for(int i=0;i<discovery_count;i++){Discovery *d=&discoveries[i];fprintf(stderr,"candidate %d t %.1f %.1f f %.1f cpa %.1f q %.1f support %.2f excess %.2f error %.2f\n",i,d->event.t[0],d->event.t[d->event.n-1],d->rest,d->cpa,d->quality,d->continuity,d->contrast,d->error);}
  for(int i=0;i<discovery_count;i++)for(int j=i+1;j<discovery_count;j++)if(discoveries[j].quality>discoveries[i].quality){Discovery d=discoveries[i];discoveries[i]=discoveries[j];discoveries[j]=d;}
  Discovery accepted[8];int count=0;
  for(int i=0;i<discovery_count;i++){
    int duplicate=0;
    for(int j=0;j<count;j++){
      if(harmonic_match(&discoveries[i],&accepted[j])){join_tone(&accepted[j],&discoveries[i]);duplicate=1;break;}
      Event *a=&discoveries[i].event,*b=&accepted[j].event;
      double overlap=fmin(a->t[a->n-1],b->t[b->n-1])-fmax(a->t[0],b->t[0]);
      // Low-level sidebands of a dominant tone must not become extra flights.
      if(overlap>.5*fmin(a->t[a->n-1]-a->t[0],b->t[b->n-1]-b->t[0])&&discoveries[i].contrast<accepted[j].contrast-12){duplicate=1;discovery_rejected++;break;}
    }
    if(!duplicate&&count<8&&independent_energy(&discoveries[i],accepted,count))accepted[count++]=discoveries[i];
  }
  for(int i=0;i<count;i++)for(int j=i+1;j<count;){
    if(harmonic_match(&accepted[i],&accepted[j])){join_tone(&accepted[i],&accepted[j]);memmove(&accepted[j],&accepted[j+1],(count-j-1)*sizeof(Discovery));count--;i=-1;break;}else j++;
  }
  // The automatic search treats events as compulsory, independent flyovers.
  // Overlapping acoustic explanations must not become contradictory flight
  // constraints. Retain the strongest representative of each overlap group;
  // simultaneous sources cannot be reliably separated by these tones alone.
  for(int i=0;i<count;i++)for(int j=i+1;j<count;j++)if(accepted[j].quality>accepted[i].quality){Discovery d=accepted[i];accepted[i]=accepted[j];accepted[j]=d;}
  int independent=0,overlapping=0;
  if(getenv("DOPPLER_DISCOVERY_DEBUG"))for(int i=0;i<count;i++){Discovery *d=&accepted[i];fprintf(stderr,"grouped %d t %.1f %.1f f %.1f cpa %.1f q %.1f support %.2f excess %.2f error %.2f\n",i,d->event.t[0],d->event.t[d->event.n-1],d->rest,d->cpa,d->quality,d->continuity,d->contrast,d->error);}
  for(int i=0;i<count;i++){
    int conflict=0;Event *a=&accepted[i].event;
    for(int j=0;j<independent;j++){
      Event *b=&accepted[j].event;double overlap=fmin(a->t[a->n-1],b->t[b->n-1])-fmax(a->t[0],b->t[0]);
      if(overlap>.5*fmin(a->t[a->n-1]-a->t[0],b->t[b->n-1]-b->t[0])){conflict=1;break;}
    }
    if(conflict)overlapping++;else accepted[independent++]=accepted[i];
  }
  count=independent;
  for(int i=0;i<count;i++)for(int j=i+1;j<count;j++)if(accepted[j].event.t[0]<accepted[i].event.t[0]){Discovery d=accepted[i];accepted[i]=accepted[j];accepted[j]=d;}
  FILE *out=fopen(output,"w");if(!out)fail("Cannot write automatic detections");
  fprintf(out,"{\"detectorVersion\":4,\"duration\":%.3f,\"rejected\":%d,\"diagnostics\":{\"support\":%d,\"motion\":%d,\"shape\":%d,\"overlappingAlternatives\":%d},\"events\":[",s->duration,discovery_rejected,rejected_support,rejected_motion,rejected_shape,overlapping);
  for(int i=0;i<count;i++){
    Discovery *d=&accepted[i];Event *e=&d->event;
    fprintf(out,"%s{\"id\":%d,\"start\":%.3f,\"end\":%.3f,\"dropHz\":%.3f,\"quality\":{\"contrastDb\":%.3f,\"continuity\":%.3f,\"mergedCandidates\":%d},\"approximation\":{\"cpaSeconds\":%.4f,\"speedMps\":%.3f,\"slantM\":%.3f,\"restHz\":%.4f,\"rmseHz\":%.4f},\"points\":[",i?",":"",i+1,e->t[0],e->t[e->n-1],e->f[0]-e->f[e->n-1],d->contrast,d->continuity,d->merged_candidates,d->cpa,d->speed,d->slant,d->rest,d->error);
    for(int p=0;p<e->n;p++)fprintf(out,"%s[%.3f,%.3f,%.3f]",p?",":"",e->t[p],e->f[p],e->w[p]);
    fputs("]}",out);
  }
  fputs("],\"measurements\":[",out);
  for(int i=0;i<count;i++){Discovery *d=&accepted[i];fprintf(out,"%s{\"id\":%d,\"cpaSeconds\":%.4f,\"cpaTolerance\":%.4f,\"minSpeed\":%.4f,\"maxSpeed\":%.4f,\"minSlant\":%.4f,\"maxSlant\":%.4f,\"minRestHz\":%.4f,\"maxRestHz\":%.4f,\"reviewed\":false,\"source\":\"automatic-profile-v4\"}",i?",":"",i+1,d->cpa,d->tolerance,d->vmin,d->vmax,d->rmin,d->rmax,d->fmin,d->fmax);}
  fputs("]}\n",out);fclose(out);free(s->values);memset(s,0,sizeof *s);
}
static void analyze(const char *path,const char *output){
  char spectral[4096];if(snprintf(spectral,sizeof spectral,"%s.spectrum.bin",output)>=(int)sizeof spectral)fail("Output path too long");
  make_spectrogram(path,spectral);discover_spectrum(spectral,output);
}
