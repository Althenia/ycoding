#!/usr/bin/env python3
import os,json,pathlib,sys,time,signal
if '--fixture-ready' in sys.argv:sys.exit(0)
base=pathlib.Path(__file__).parent
mode=(base/'mode').read_text()
behavior=json.loads((base/'behavior').read_text()) if (base/'behavior').exists() else {}
if '--version' in sys.argv:
    with open(base/'probes','a') as probes:probes.write('x')
    if mode=='probe-ignore-term':
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        (base/'probe-pid').write_text(str(os.getpid()))
        time.sleep(30)
    if mode=='deadline':time.sleep(2.5)
    if mode=='spawn-failure':pathlib.Path(__file__).unlink()
    print('Google Chrome 152.0.0')
    sys.exit(0)
root=pathlib.Path(next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--user-data-dir='))).parent
root.joinpath('profile').mkdir(mode=0o700)
root.joinpath('profile','data').write_text('owned profile')
(base/'record').write_text(json.dumps({'pid':os.getpid(),'root':str(root),'permissions':root.stat().st_mode & 511,'group':os.getpgrp(),'args':sys.argv}))
if mode=='ignore-term':signal.signal(signal.SIGTERM,signal.SIG_IGN)
if behavior.get('term_marker'):
    def terminated(*_):
        (base/'terminated').write_text('1')
        os._exit(0)
    signal.signal(signal.SIGTERM,terminated)
if behavior.get('grandchild'):
    import subprocess
    code='import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(60)'
    (base/'grandchild-pid').write_text(str(subprocess.Popen([sys.executable,'-c',code,str(base)]).pid))
reader=os.fdopen(3,'rb',buffering=0)
writer=os.fdopen(4,'wb',buffering=0)
log=open(base/'commands.log','a',buffering=1)
def send(message):
    writer.write(json.dumps(message).encode()+b'\0')
results={
    'Browser.getVersion':lambda:{'product':'Chrome/'+('151.0.0' if mode=='changed' else '152.0.0')},
    'Target.createBrowserContext':lambda:{'browserContextId':'ctx-1'},
    'Target.createTarget':lambda:{'targetId':'target-main'},
    'Target.attachToTarget':lambda:{'sessionId':'session-main'},
    'Page.getFrameTree':lambda:{'frameTree':{'frame':{'id':'frame-main','url':state['url']}}},
    'Target.getTargetInfo':lambda:{'targetInfo':{'targetId':'target-main','url':state['url'],'title':behavior.get('title','Fixture')}},
    'Accessibility.getFullAXTree':lambda:{'nodes':behavior.get('ax',[])},
    'DOM.describeNode':lambda:{'node':behavior.get('dom',{}).get(str(command['params']['backendNodeId']),{'nodeName':'DIV','attributes':[]})},
    'DOM.getContentQuads':lambda:{'quads':behavior.get('quads',[[0,0,10,0,10,10,0,10]])},
    'DOM.getDocument':lambda:{'root':behavior.get('document',{'nodeName':'#document','children':[]})},
    'Page.captureScreenshot':lambda:{'data':behavior.get('screenshot','iVBORw0KGgo=')},
    'Page.navigate':lambda:navigate(command),
    'Target.closeTarget':lambda:{'success':True},
}
empty={'Browser.setDownloadBehavior','Browser.setPermission','Page.enable','Inspector.enable','Page.setInterceptFileChooserDialog','Fetch.enable','Target.setDiscoverTargets','Target.setAutoAttach','Target.disposeBrowserContext','Emulation.setScriptExecutionDisabled','Runtime.runIfWaitingForDebugger','Fetch.continueRequest','Fetch.failRequest','Page.stopLoading','Browser.close','DOM.enable','Accessibility.enable','DOM.scrollIntoViewIfNeeded','DOM.focus','Input.insertText','Input.dispatchMouseEvent'}
state={'url':'about:blank','pending':{},'navigations':0}
def navigate(command):
    url=command['params']['url']
    state['navigations']+=1
    request='navigation-'+str(state['navigations'])
    state['pending'][request]=behavior.get('lands',{}).get(url,url)
    if not behavior.get('stuck_navigation'):
        send({'method':'Fetch.requestPaused','sessionId':'session-main','params':{'requestId':request,'request':{'url':url},'resourceType':'Document','frameId':'frame-main'}})
    return {'frameId':'frame-main'}
def land(request):
    state['url']=state['pending'].pop(request)
    send({'method':'Page.frameNavigated','sessionId':'session-main','params':{'frame':{'id':'frame-main','url':state['url']}}})
reported=False
while True:
    frame=bytearray()
    while True:
        byte=reader.read(1)
        if not byte:
            if mode=='ignore-term':time.sleep(30)
            sys.exit(0)
        if byte==b'\0':break
        frame.extend(byte)
    command=json.loads(frame)
    method=command['method']
    log.write(json.dumps({'method':method,'sessionId':command.get('sessionId'),'params':command.get('params',{})})+'\n')
    if not reported:
        send({'method':'Test.handshake','params':{}})
        reported=True
    if mode=='ignore-term' and method=='Browser.close':continue
    if mode=='deadline':time.sleep(2.5)
    if mode=='hang':time.sleep(30)
    if method in behavior.get('silent',[]):continue
    if method in behavior.get('fail',[]):
        send({'id':command['id'],'error':{'code':-32000,'message':'refused'}})
        continue
    if method=='Test.exit':sys.exit(2)
    if method=='Test.disconnect':
        writer.close()
        time.sleep(30)
    if method=='Test.emit':
        for event in command['params']['events']:send(event)
        send({'id':command['id'],'result':{}})
        continue
    if method in results:result=results[method]()
    elif method in empty:result={}
    else:
        send({'id':command['id'],'error':{'code':-32601,'message':'unknown method'}})
        continue
    send({'id':command['id'],'result':result})
    if method=='Fetch.continueRequest' and command['params']['requestId'] in state['pending']:land(command['params']['requestId'])
    if method=='Fetch.failRequest':state['pending'].pop(command['params']['requestId'],None)
    if method=='Input.dispatchMouseEvent' and command['params'].get('type')=='mouseReleased':
        if 'click_url' in behavior:state['url']=behavior['click_url']
        for event in behavior.get('on_click',[]):send(event)
    if method=='Target.closeTarget' and not behavior.get('no_destroy_ack'):
        send({'method':'Target.targetDestroyed','params':{'targetId':command['params']['targetId']}})
    if method=='Browser.close':
        time.sleep(behavior.get('linger',0))
        sys.exit(0)
