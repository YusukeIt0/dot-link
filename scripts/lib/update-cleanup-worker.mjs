// One-shot housekeeping never recovers or modifies an active update journal.
import {finishUpdate} from './app-update.mjs';
try{await finishUpdate(process.argv[2],{cleanupOnly:true,...(process.argv[3]?{app:process.argv[3]}:{})});}catch{process.exitCode=1;}
