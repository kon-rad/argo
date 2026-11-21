import { json, Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { CybazaarIntegration, CybazaarIntegrationError, type CybazaarRequest } from './cybazaar-integration.js';

const action=z.object({summary:z.string().max(2000).optional()}).strict()
const actions:Record<string,CybazaarRequest['status']>={accept:'accepted',reject:'rejected',start:'in_progress',request_changes:'revision_requested',complete:'completed'}
function sendError(error:unknown,res:Response):void{
  if(error instanceof CybazaarIntegrationError){res.status(error.status).json({error:{message:error.message}});return}
  res.status(503).json({error:{message:'Cybazaar request operation failed.'}})
}
export function cybazaarRequestsRouter(integration:CybazaarIntegration,ownerGate:(req:Request,res:Response,next:NextFunction)=>unknown):Router{
  const router=Router()
  router.use(ownerGate)
  router.use(json({limit:'16kb',strict:true}))
  router.get('/requests',async(_req,res)=>{try{const result=await integration.list();res.setHeader('Cache-Control','no-store');res.json(result)}catch(error){sendError(error,res)}})
  router.post('/requests/:id/:action',async(req,res)=>{
    const status=actions[req.params.action]
    if(!status){res.status(404).json({error:{message:'Unknown request action.'}});return}
    const parsed=action.safeParse(req.body)
    if(!parsed.success){res.status(400).json({error:{message:'Invalid request update.'}});return}
    try{const marketplaceSync=await integration.transition(req.params.id,status,parsed.data.summary);res.setHeader('Cache-Control','no-store');res.json({status,marketplaceSync:marketplaceSync?'synced':'pending'})}
    catch(error){sendError(error,res)}
  })
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>sendError(error,res))
  return router
}
