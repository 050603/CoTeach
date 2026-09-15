#!/usr/bin/env python3
"""Offline model-form comparison using saved measurements only; no network.
Requires Python 3, NumPy and SciPy. The feature extraction mirrors algorithm 3/4
for this Chinese/English corpus. Runtime replay uses replay-tts-timing.ts.
"""
import json,re,unicodedata,numpy as np
from scipy.optimize import lsq_linear
import argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Select a timing loss using only independent calibration LOOCV, then evaluate the frozen model.')
parser.add_argument('--input', required=True, help='Saved first-pass results JSON')
parser.add_argument('--output-dir', required=True)
parser.add_argument('--seed-cjk-rate', type=float, default=275, help='Qwen Flash seed characters/minute')
parser.add_argument('--seed-latin-rate', type=float, default=155, help='Qwen Flash seed reference words/minute')
parser.add_argument('--seed-pause', type=float, default=.17)
args=parser.parse_args()
out=Path(args.output_dir);out.mkdir(parents=True,exist_ok=True)
r=json.load(open(args.input))['results']
languages=list(dict.fromkeys(z['language'] for z in r))
training=[x for x in r if x['phase']=='independent-calibration']

def vector(row,split=False):
 t=unicodedata.normalize('NFKC',row['text'])
 c=len(re.findall('[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]',t))
 t=re.sub('[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]',' ',t)
 words=re.findall("[A-Za-z]+(?:['’][A-Za-z]+)?|[0-9]+(?:\\.[0-9]+)?",t)
 syl=0
 for w in words:
  if re.fullmatch('[A-Z]{2,6}',w): syl+=len(w)+2*w.count('W')
  elif re.match('[0-9]',w): syl+=len(w.replace('.',''))+('.' in w)
  else:
   low=re.sub('(?:[^laeiouy]es|ed|[^laeiouy]e)$','',w.lower());low=re.sub('^y','',low)
   syl+=max(1,len(re.findall('[aeiouy]{1,2}',low)))
 short=len(re.findall('[,;:、]',t));long=len(re.findall('[。.!?]',t))
 return np.array([1,c,syl/1.5,short,long] if split else [1,c,syl/1.5,short+long],float)

def fit(rows,mode):
 split='split' in mode; relative='relative' in mode
 x=np.array([vector(z,split) for z in rows]);y=np.array([z['actualSec'] for z in rows])
 prior=np.array([.2,60/args.seed_cjk_rate,60/args.seed_latin_rate,args.seed_pause,args.seed_pause] if split else [.2,60/args.seed_cjk_rate,60/args.seed_latin_rate,args.seed_pause])
 penalty=np.array([2,600,150,30,30] if split else [2,600,150,30])
 weights=np.median(y)/y if relative else np.ones(len(y))
 bounds=([0,.06,.12,0,0],[1.5,.6,1.2,.8,.8]) if split else ([0,.06,.12,0],[1.5,.6,1.2,.8])
 return lsq_linear(np.vstack([x*weights[:,None],np.diag(np.sqrt(penalty))]),np.r_[y*weights,np.sqrt(penalty)*prior],bounds=bounds).x

modes=['baseline','relative','split','relative-split']
metrics={}
for mode in modes:
 errors=[]; langs={}
 for lang in languages:
  rows=[z for z in training if z['language']==lang];errs=[]
  for i,row in enumerate(rows):
   coef=fit(rows[:i]+rows[i+1:],mode);pred=vector(row,'split' in mode)@coef
   errs.append(row['actualSec']/pred-1)
  errors.extend(errs);langs[lang]={'pass':int(sum(abs(e)<=.1 for e in errs)),'mape':np.mean(np.abs(errs)).item(),'errors':errs}
 metrics[mode]={'pass':int(sum(abs(e)<=.1 for e in errors)),'mape':np.mean(np.abs(errors)).item(),'languages':langs}
print(json.dumps(metrics,indent=2));json.dump(metrics,open(out/'calibration-loocv.json','w'),indent=2)
# Select before looking at any held-out predictions; no tuning against held-out rows.
selected=min(modes,key=lambda mode:metrics[mode]['mape'])
print('Selected solely by calibration MAPE:', selected)
heldout={}
for lang in languages:
 coef=fit([z for z in training if z['language']==lang],selected)
 rows=[z for z in r if z['phase']=='held-out' and z['language']==lang]
 predictions=[round(float(vector(z,'split' in selected)@coef),1) for z in rows]
 errors=[z['actualSec']/v-1 for z,v in zip(rows,predictions)]
 heldout[lang]={'coefficients':coef.tolist(),'pass':int(sum(abs(e)<=.1 for e in errors)), 'mape':float(np.mean(np.abs(errors))),'predictions':predictions}
print('Frozen selected model held-out comparison:');print(json.dumps(heldout,indent=2));json.dump(heldout,open(out/'selected-heldout.json','w'),indent=2)
