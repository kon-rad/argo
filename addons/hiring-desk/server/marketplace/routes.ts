import { json, Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { COMPANION_CAPABILITIES, CybazaarIntegration, CybazaarIntegrationError, type CybazaarRequest } from './cybazaar-integration.js';

const action=z.object({summary:z.string().max(2000).optional()}).strict()
const profile=z.object({name:z.string().max(200).optional(),description:z.string().max(4000).optional(),image_url:z.string().max(2000).nullable().optional()}).strict()
const actions:Record<string,CybazaarRequest['status']>={accept:'accepted',reject:'rejected',start:'in_progress',request_changes:'revision_requested',complete:'completed'}
function sendError(error:unknown,res:Response):void{
  res.setHeader('Cache-Control','no-store')
  if(error instanceof CybazaarIntegrationError){res.status(error.status).json({error:{code:error.code??(error.status===501?'unsupported':'failed'),message:error.message}});return}
  res.status(503).json({error:{code:'unavailable',message:'Cybazaar request operation failed.'}})
}
const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
  try{const value=await fn(req,res);res.setHeader('Cache-Control','no-store');res.json(value)}catch(error){sendError(error,res)}
}
/** Every route sits behind the owner session gate. Nothing here is reachable without it. */
export function cybazaarRequestsRouter(integration:CybazaarIntegration,ownerGate:(req:Request,res:Response,next:NextFunction)=>unknown):Router{
  const router=Router()
  router.use(ownerGate)
  router.use(json({limit:'16kb',strict:true}))
  router.get('/capabilities',handle(async()=>{
    const available=await integration.capabilities()
    return {requests:true,companion:Object.fromEntries(COMPANION_CAPABILITIES.map(name=>[name,available.has(name)]))}
  }))
  router.get('/requests',handle(()=>integration.list()))
  router.post('/requests/:id/:action',async(req,res)=>{
    const status=actions[String(req.params.action)]
    if(!status){res.status(404).json({error:{code:'not_found',message:'Unknown request action.'}});return}
    const parsed=action.safeParse(req.body??{})
    if(!parsed.success){res.status(400).json({error:{code:'invalid',message:'Invalid request update.'}});return}
    try{const marketplaceSync=await integration.transition(String(req.params.id),status,parsed.data.summary);res.setHeader('Cache-Control','no-store');res.json({status,marketplaceSync:marketplaceSync?'synced':'pending'})}
    catch(error){sendError(error,res)}
  })
  router.get('/services',handle(async()=>({listings:await integration.listings()})))
  router.get('/agents',handle(async()=>({agents:await integration.agents()})))
  router.patch('/agents/:agentId',handle(async req=>{
    const parsed=profile.safeParse(req.body??{})
    if(!parsed.success)throw new CybazaarIntegrationError(400,'Invalid profile update.','invalid')
    return {agent:await integration.updateAgent(String(req.params.agentId),parsed.data)}
  }))
  router.delete('/agents/:agentId/listings/:listingId',handle(async req=>({listing:await integration.removeFromListing(String(req.params.agentId),String(req.params.listingId))})))
  router.get('/messages',handle(()=>integration.messages()))
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>sendError(error,res))
  return router
}
