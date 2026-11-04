package io.tapdata.mini;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.core.type.TypeReference;
import io.tapdata.entity.codec.TapCodecsRegistry;
import io.tapdata.entity.logger.TapLog;
import io.tapdata.entity.schema.*;
import io.tapdata.entity.utils.DataMap;
import io.tapdata.entity.utils.cache.Entry;
import io.tapdata.entity.utils.cache.Iterator;
import io.tapdata.entity.utils.cache.KVMap;
import io.tapdata.entity.utils.cache.KVReadOnlyMap;
import io.tapdata.entity.event.dml.TapInsertRecordEvent;
import io.tapdata.pdk.apis.*;
import io.tapdata.pdk.apis.annotations.TapConnectorClass;
import io.tapdata.pdk.apis.context.TapConnectorContext;
import io.tapdata.pdk.apis.entity.*;
import io.tapdata.pdk.apis.functions.ConnectorFunctions;
import io.tapdata.pdk.apis.consumer.StreamReadConsumer;
import io.tapdata.entity.event.TapEvent;
import io.tapdata.pdk.apis.spec.TapNodeSpecification;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.jar.*;

/** Stdio JSON-RPC control plane. Data batches stay inside this JVM. */
public class Main {
    static final ObjectMapper JSON=new ObjectMapper();
    static final PrintStream PROTOCOL=new PrintStream(new FileOutputStream(FileDescriptor.out),true,StandardCharsets.UTF_8);
    static final Map<String,Plugin> plugins=new HashMap<>();
    static final Map<String,Operation> operations=new ConcurrentHashMap<>();
    static final ExecutorService worker=Executors.newSingleThreadExecutor();
    static final Map<String,PageCursor> pageCursors=new ConcurrentHashMap<>();
    record PageCursor(String pdkId,String table,String configKey,Object offset,List<Object> pending) {}
    static class Operation { volatile boolean cancelled; volatile TapConnector connector; volatile TapConnectorContext context; }
    static class StopRead extends RuntimeException {}
    static class PageStop extends RuntimeException { final String cursor; PageStop(String cursor){this.cursor=cursor;} }
    static class MemoryMap implements KVMap<Object> {
        final ConcurrentHashMap<String,Object> values=new ConcurrentHashMap<>();
        public void init(String k,Class<Object> t) {} public Object get(String k){return values.get(k);}
        public void put(String k,Object v){values.put(k,v);} public Object putIfAbsent(String k,Object v){return values.putIfAbsent(k,v);}
        public Object remove(String k){return values.remove(k);} public void clear(){values.clear();} public void reset(){clear();}
    }
    static class Plugin implements AutoCloseable {
        URLClassLoader loader; Class<? extends TapConnector> type; JsonNode spec; Map<String,Object> info;
        public void close() throws Exception {loader.close();}
    }
    static synchronized void emit(Object value) {try {PROTOCOL.println(JSON.writeValueAsString(value));}catch(Exception e){System.err.println("Protocol encoding failed");}}
    static Map<String,Object> obj(Object... kv) {var m=new LinkedHashMap<String,Object>();for(int i=0;i<kv.length;i+=2)m.put((String)kv[i],kv[i+1]);return m;}
    static Plugin plugin(JsonNode p) throws Exception {
        String jar=Path.of(p.path("jar").asText()).toRealPath().toString();
        String className=p.path("className").asText(""); String key=jar+"#"+className;
        if(plugins.containsKey(key))return plugins.get(key);
        var urls=new ArrayList<URL>();urls.add(Path.of(jar).toUri().toURL());
        for(var dep:p.path("dependencies")) urls.add(Path.of(dep.asText()).toUri().toURL());
        var plug=new Plugin(); plug.loader=new URLClassLoader(urls.toArray(URL[]::new),Main.class.getClassLoader());
        try {
            var candidates=new ArrayList<Class<? extends TapConnector>>();
            try(var jf=new JarFile(jar)) {
                var entries=jf.entries();
                while(entries.hasMoreElements()) {
                    String n=entries.nextElement().getName();
                    if(!n.endsWith(".class")||n.contains("$")||n.startsWith("META-INF"))continue;
                    String cn=n.substring(0,n.length()-6).replace('/','.');
                    if(!className.isEmpty()&&!className.equals(cn))continue;
                    try {
                        Class<?> c=Class.forName(cn,false,plug.loader);
                        if(TapConnector.class.isAssignableFrom(c)&&c.getAnnotation(TapConnectorClass.class)!=null&&!java.lang.reflect.Modifier.isAbstract(c.getModifiers())) candidates.add(c.asSubclass(TapConnector.class));
                    } catch(ClassNotFoundException|LinkageError ignored) {}
                }
                if(candidates.size()!=1)throw new IllegalArgumentException("Expected one PDK connector; use --class to select. Found: "+candidates.stream().map(Class::getName).toList());
                plug.type=candidates.get(0);
                String specPath=plug.type.getAnnotation(TapConnectorClass.class).value();
                JarEntry entry=jf.getJarEntry(specPath);
                if(entry==null)throw new IllegalArgumentException("Missing connector specification: "+specPath);
                try(var in=jf.getInputStream(entry)){plug.spec=JSON.readTree(in);}
                var props=plug.spec.path("properties");
                String id=props.path("id").asText("");if(id.isEmpty())throw new IllegalArgumentException("Missing PDK id");
                var manifest=jf.getManifest();
                String version=props.path("version").asText(manifest==null?"unknown":Objects.toString(manifest.getMainAttributes().getValue("Implementation-Version"),"unknown"));
                var connector=plug.type.getConstructor().newInstance();var funcs=new ConnectorFunctions();connector.registerCapabilities(funcs,TapCodecsRegistry.create());
                var caps=new LinkedHashMap<String,Object>();
                caps.put("test",true); caps.put("discover",true);
                for(var cap:funcs.getCapabilities()) caps.put(cap.getId(),true);
                plug.info=obj("pdkId",id,"version",version,"name",props.path("name").asText(id),"className",plug.type.getName(),"configOptions",plug.spec.path("configOptions"),"capabilities",caps);
            }
            plugins.put(key,plug);return plug;
        } catch(Throwable e){plug.close();throw e;}
    }
    static TapConnectorContext context(Plugin plug,JsonNode p) {
        var props=plug.spec.path("properties");var spec=new TapNodeSpecification();
        spec.setId(props.path("id").asText());spec.setName(props.path("name").asText());spec.setGroup(props.path("group").asText("io.tapdata"));spec.setVersion(Objects.toString(plug.info.get("version")));
        spec.setConfigOptions(DataMap.create(JSON.convertValue(plug.spec.path("configOptions"),new TypeReference<Map<String,Object>>(){})));
        var ctx=new TapConnectorContext(spec,DataMap.create(JSON.convertValue(p.path("config"),new TypeReference<Map<String,Object>>(){})),DataMap.create(),null,new TapLog());
        ctx.setStateMap(new MemoryMap());ctx.setGlobalStateMap(new MemoryMap());return ctx;
    }
    static List<TapTable> discover(TapConnector c,TapConnectorContext ctx,String table) throws Throwable {
        var tables=new ArrayList<TapTable>();
        c.discoverSchema(ctx,table==null?null:List.of(table),100,batch->{if(tables.size()+batch.size()>5000)throw new IllegalArgumentException("More than 5000 tables; select a table");tables.addAll(batch);});
        var map=new HashMap<String,TapTable>();for(var t:tables)map.put(t.getId(),t);
        ctx.setTableMap(new KVReadOnlyMap<>() {
            public TapTable get(String id) { return map.get(id); }
            public Iterator<Entry<TapTable>> iterator() {
                var entries=map.entrySet().iterator();
                return new Iterator<>() {
                    public boolean hasNext() { return entries.hasNext(); }
                    public Entry<TapTable> next() {
                        var entry=entries.next();
                        return new Entry<>() {
                            public String getKey() { return entry.getKey(); }
                            public TapTable getValue() { return entry.getValue(); }
                        };
                    }
                };
            }
        });
        return tables;
    }
    static Object safeValue(Object v) {
        if(v instanceof Long || v instanceof java.math.BigInteger || v instanceof java.math.BigDecimal)return v.toString();
        if(v instanceof byte[] b)return obj("encoding","base64","data",Base64.getEncoder().encodeToString(b));
        if(v instanceof Map<?,?> m){var r=new LinkedHashMap<String,Object>();m.forEach((k,x)->r.put(String.valueOf(k),safeValue(x)));return r;}
        if(v instanceof Collection<?> l)return l.stream().map(Main::safeValue).toList();
        return v;
    }
    static String csv(Object v)throws Exception {String s=v==null?"":v instanceof Map||v instanceof Collection?JSON.writeValueAsString(v):v.toString();return "\""+s.replace("\"","\"\"")+"\"";}
    static Object execute(String method,JsonNode p,Operation op,String requestId)throws Throwable {
        if(method.equals("engine.hello"))return obj("protocolVersion",1,"engineVersion","0.1.0","javaVersion",System.getProperty("java.version"));
        Plugin plug=plugin(p);Thread.currentThread().setContextClassLoader(plug.loader);
        if(method.equals("connector.inspect"))return plug.info;
        if(method.equals("connector.unload")){plugins.values().removeIf(x->x==plug);plug.close();return obj("unloaded",true);}
        var connector=plug.type.getConstructor().newInstance();var ctx=context(plug,p);op.connector=connector;op.context=ctx;
        var funcs=new ConnectorFunctions();connector.registerCapabilities(funcs,TapCodecsRegistry.create());
        try {
            if(op.cancelled)throw new CancellationException();
            if(method.equals("datasource.test")) {
                var checks=new ArrayList<Object>();var ok=new boolean[]{true};
                connector.connectionTest(ctx,item->{ok[0]&=item.isSuccess();checks.add(obj("item",item.getItem(),"result",item.getResult(),"message",item.getInformation()));});
                return obj("passed",ok[0]&&!checks.isEmpty(),"checks",checks);
            }
            connector.init(ctx);
            if(method.equals("datasource.command")) {
                if(funcs.getExecuteCommandFunction()==null)throw new IllegalArgumentException("Connector does not support execute_command_function");
                String command=p.path("command").asText(""); if(command.isBlank())throw new IllegalArgumentException("Missing command");
                var commandResult=new ArrayList<Object>();
                var request=TapExecuteCommand.create().command(command).params(JSON.convertValue(p.path("commandParams"),new TypeReference<Map<String,Object>>(){})).batchSize(p.path("batchSize").asInt(100));
                funcs.getExecuteCommandFunction().execute(ctx,request,result->{
                    if(result.getError()!=null)throw new RuntimeException("Connector command failed: "+result.getError().getMessage());
                    if(result.getResult()!=null)commandResult.add(safeValue(result.getResult()));
                    if(commandResult.size()>1000)throw new IllegalArgumentException("Command returned more than 1000 result batches");
                });
                return obj("command",command,"results",commandResult,"batches",commandResult.size());
            }
            if(method.equals("datasource.sql")) {
                var function=funcs.getExecuteCommandV2Function();
                if(function==null)throw new IllegalArgumentException("Connector does not support execute_command_v2_function");
                String sql=p.path("sql").asText(""); String sqlType=p.path("sqlType").asText("query");
                if(sql.isBlank())throw new IllegalArgumentException("Missing SQL");
                if(!sqlType.equals("query")&&!sqlType.equals("execute"))throw new IllegalArgumentException("SQL type must be query or execute");
                var resultRows=new ArrayList<Object>();var batches=new int[]{0};
                function.execute(ctx,sqlType,sql,data->{
                    batches[0]++;
                    if(data!=null)for(var row:data){if(resultRows.size()>=1000)throw new IllegalArgumentException("SQL returned more than 1000 rows; add a database-side limit");resultRows.add(safeValue(row));}
                });
                return obj("sqlType",sqlType,"rows",resultRows,"count",resultRows.size(),"batches",batches[0]);
            }
            if(method.equals("datasource.tables")) {
                var function=funcs.getGetTableNamesFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support get_table_names_function");
                var names=new LinkedHashSet<String>();
                function.tableNames(ctx,500,batch->{if(batch!=null)names.addAll(batch);if(names.size()>5000)throw new IllegalArgumentException("More than 5000 table names; use datasource load --table");});
                return obj("tables",new ArrayList<>(names),"count",names.size());
            }
            if(method.equals("datasource.tableInfo")) {
                var function=funcs.getGetTableInfoFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support get_table_info_function");
                String tableName=p.path("table").asText("");if(tableName.isBlank())throw new IllegalArgumentException("Missing table");
                var result=function.getTableInfo(ctx,tableName);
                if(result==null)throw new IllegalArgumentException("Connector returned no table information");
                return obj("table",tableName,"numOfRows",result.getNumOfRows(),"storageSize",result.getStorageSize(),"avgObjSize",result.getAvgObjSize());
            }
            if(method.equals("datasource.now")) {
                var function=funcs.getGetCurrentTimestampFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support get_current_timestamp_function");
                return obj("timestamp",function.now(ctx));
            }
            if(method.equals("datasource.streamRead")) {
                var streamFunction=funcs.getStreamReadFunction();
                if(streamFunction==null)throw new IllegalArgumentException("Connector does not support stream_read_function");
                String requestedTable=p.path("table").asText("");
                List<String> tableList=requestedTable.isBlank()?null:List.of(requestedTable);
                discover(connector,ctx,requestedTable.isBlank()?null:requestedTable);
                Object offset=null;
                long startTime=p.path("startTime").asLong(System.currentTimeMillis());
                var timestampOffset=funcs.getTimestampToStreamOffsetFunction();
                if(timestampOffset!=null)offset=timestampOffset.timestampToStreamOffset(ctx,startTime);
                var seen=new long[]{0};
                var consumer=StreamReadConsumer.create((events,nextOffset)->{
                    if(op.cancelled)throw new CancellationException();
                    if(events==null||events.isEmpty())return;
                    var payload=new ArrayList<Object>(events.size());
                    for(TapEvent event:events){payload.add(JSON.convertValue(safeValue(event),Object.class));seen[0]++;}
                    emit(obj("jsonrpc","2.0","method","stream.records","params",obj("requestId",requestId,"records",payload,"count",seen[0],"offset",safeValue(nextOffset))));
                });
                streamFunction.streamRead(ctx,tableList,offset,p.path("recordSize").asInt(20),consumer);
                return obj("count",seen[0],"startTime",startTime,"usedTimestampOffset",timestampOffset!=null,"ended",true);
            }
            String table=p.hasNonNull("table")?p.path("table").asText():null;
            var tables=discover(connector,ctx,table);
            if(method.equals("datasource.discover"))return obj("tables",tables.stream().map(t->{
                var fields=t.getNameFieldMap()==null?List.of():t.getNameFieldMap().values().stream().map(f->obj("name",f.getName(),"type",f.getDataType(),"primaryKey",f.getPrimaryKeyPos())).toList();
                return obj("id",t.getId(),"name",t.getName(),"fields",fields);
            }).toList());
            if(!Set.of("datasource.sample","datasource.page","datasource.query","datasource.count","datasource.indexes","datasource.constraints","datasource.minmax","task.export").contains(method))throw new IllegalArgumentException("Unknown method");
            if(table==null)throw new IllegalArgumentException("Missing table");
            var tapTable=tables.stream().filter(t->table.equals(t.getId())).findFirst().orElseThrow(()->new IllegalArgumentException("Table not found: "+table));
            if(method.equals("datasource.count")) {
                var function=funcs.getBatchCountFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support batch_count_function");
                return obj("table",table,"count",function.count(ctx,tapTable));
            }
            if(method.equals("datasource.indexes")) {
                var function=funcs.getQueryIndexesFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support query_indexes_function");
                var result=new Object[]{null};function.query(ctx,tapTable,x->result[0]=x);
                return obj("table",table,"indexes",result[0]==null?List.of():JSON.convertValue(result[0],Object.class));
            }
            if(method.equals("datasource.constraints")) {
                var function=funcs.getQueryConstraintsFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support query_constraints_function");
                var result=new Object[]{null};function.query(ctx,tapTable,x->result[0]=x);
                return obj("table",table,"constraints",result[0]==null?List.of():JSON.convertValue(result[0],Object.class));
            }
            if(method.equals("datasource.minmax")) {
                var function=funcs.getQueryFieldMinMaxValueFunction();
                if(function==null)throw new IllegalArgumentException("Connector does not support query_field_min_max_value_function");
                String field=p.path("field").asText("");if(field.isBlank())throw new IllegalArgumentException("Missing field");
                TapAdvanceFilter filter=p.hasNonNull("filter")?JSON.treeToValue(p.path("filter"),TapAdvanceFilter.class):TapAdvanceFilter.create();
                var result=function.minMaxValue(ctx,tapTable,filter,field);
                return obj("table",table,"field",field,"value",result==null?null:JSON.convertValue(result,Object.class));
            }
            boolean querying=method.equals("datasource.query");
            if(querying&&funcs.getQueryByAdvanceFilterFunction()==null)throw new IllegalArgumentException("Connector does not support query_by_advance_filter_function");
            if(!querying&&funcs.getBatchReadFunction()==null)throw new IllegalArgumentException("Connector has no batchRead capability");
            boolean exporting=method.equals("task.export"), paging=method.equals("datasource.page");int limit=p.path("limit").asInt(10);
            if(!exporting&&(limit<1||limit>100))throw new IllegalArgumentException("Read limit must be 1..100");
            if(querying) {
                TapAdvanceFilter filter=p.hasNonNull("filter")?JSON.treeToValue(p.path("filter"),TapAdvanceFilter.class):TapAdvanceFilter.create();
                filter.setLimit(limit); filter.setBatchSize(limit); filter.setSkip(p.path("skip").asInt(0));
                if(p.hasNonNull("sort")) filter.setSortOnList(JSON.convertValue(p.path("sort"),new TypeReference<List<SortOn>>(){}));
                if(p.hasNonNull("projection")) {
                    var projection=Projection.create();
                    p.path("projection").path("includeFields").forEach(x->projection.include(x.asText()));
                    p.path("projection").path("excludeFields").forEach(x->projection.exclude(x.asText()));
                    filter.setProjection(projection);
                }
                var result=new FilterResults[1];
                funcs.getQueryByAdvanceFilterFunction().query(ctx,filter,tapTable,x->result[0]=x);
                if(result[0]==null)throw new IllegalArgumentException("Connector query returned no result");
                if(result[0].getError()!=null)throw new RuntimeException("Connector query failed: "+result[0].getError().getMessage());
                var found=result[0].getResults()==null?List.<Object>of():result[0].getResults().stream().limit(limit).map(Main::safeValue).toList();
                return obj("rows",found,"count",found.size(),"limit",limit,"skip",filter.getSkip(),"sort",filter.getSortOnList());
            }
            String configKey=JSON.writeValueAsString(obj("config",p.path("config"),"jar",p.path("jar"),"className",p.path("className"),"dependencies",p.path("dependencies")));
            Object startOffset=null;
            List<Object> pendingRows=new ArrayList<>();
            if(paging&&p.hasNonNull("cursor")) {
                PageCursor cursor=pageCursors.remove(p.path("cursor").asText());
                if(cursor==null)throw new IllegalArgumentException("Page cursor expired; restart without --cursor");
                if(!cursor.pdkId().equals(p.path("pdkId").asText())||!cursor.table().equals(table)||!cursor.configKey().equals(configKey))throw new IllegalArgumentException("Page cursor does not match this datasource and table");
                startOffset=cursor.offset();
                pendingRows.addAll(cursor.pending());
            }
            var rows=new ArrayList<Object>();var count=new long[]{0};var columns=new ArrayList<>(tapTable.getNameFieldMap().keySet());
            var excludes=new HashSet<String>();p.path("exclude").forEach(x->excludes.add(x.asText()));if(!columns.containsAll(excludes))throw new IllegalArgumentException("Unknown excluded field; inspect table metadata first");columns.removeAll(excludes);
            if(exporting&&columns.isEmpty())throw new IllegalArgumentException("Export has no columns");
            Path output=exporting?Path.of(p.path("output").asText()).toAbsolutePath():null;
            Path partial=exporting?Path.of(output+".partial"):null;
            if(exporting&&Files.exists(output))throw new IllegalArgumentException("Output exists; choose a new path");
            try(BufferedWriter writer=exporting?Files.newBufferedWriter(partial,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW):null) {
                if(exporting){writer.write(String.join(",",columns.stream().map(x->{try{return csv(x);}catch(Exception e){throw new RuntimeException(e);}}).toList()));writer.newLine();}
                while(paging&&!pendingRows.isEmpty()&&count[0]<limit){rows.add(pendingRows.remove(0));count[0]++;}
                if(paging&&count[0]>=limit) {
                    if(pageCursors.size()>1000)pageCursors.clear();String token=UUID.randomUUID().toString();
                    pageCursors.put(token,new PageCursor(p.path("pdkId").asText(),table,configKey,startOffset,new ArrayList<>(pendingRows)));
                    startOffset=token;
                }
                String[] nextCursor={null};Object readOffset=startOffset;
                try {
                    if(!paging||count[0]<limit)funcs.getBatchReadFunction().batchRead(ctx,tapTable,readOffset,exporting?500:limit,(events,nextOffset)->{
                        if(op.cancelled)throw new CancellationException();
                        for(var event:events)if(event instanceof TapInsertRecordEvent insert){
                            @SuppressWarnings("unchecked") var row=(Map<String,Object>)safeValue(insert.getAfter());
                            if(paging&&count[0]>=limit){pendingRows.add(row);continue;}
                            if(!exporting&&count[0]>=limit)throw new StopRead();
                            if(exporting)try {var values=new ArrayList<String>();for(String col:columns)values.add(csv(row.get(col)));writer.write(String.join(",",values));writer.newLine();}catch(Exception e){throw new RuntimeException(e);}
                            else rows.add(row);count[0]++;
                        }
                        if(exporting)emit(obj("jsonrpc","2.0","method","task.progress","params",obj("requestId",requestId,"written",count[0],"output",output.toString())));
                        if(!exporting&&count[0]>=limit) {
                            if(paging&&nextOffset!=null) {
                                if(pageCursors.size()>1000)pageCursors.clear();
                                String token=UUID.randomUUID().toString();
                                pageCursors.put(token,new PageCursor(p.path("pdkId").asText(),table,configKey,nextOffset,new ArrayList<>(pendingRows)));
                                nextCursor[0]=token;
                                throw new PageStop(token);
                            }
                            throw new StopRead();
                        }
                    });
                }catch(StopRead finished){}catch(PageStop finished){}
                if(op.cancelled)throw new CancellationException();
                if(paging&&nextCursor[0]!=null)startOffset=nextCursor[0];
            }
            if(exporting){Files.move(partial,output);return obj("written",count[0],"output",output.toString());}
            if(paging)return obj("rows",rows,"count",count[0],"limit",limit,"cursor",startOffset);
            return obj("rows",rows,"count",count[0],"limit",limit);
        } finally {
            try{connector.stop(ctx);}catch(Throwable e){System.err.println("Connector stop failed: "+e.getClass().getSimpleName());}
            Thread.currentThread().setContextClassLoader(Main.class.getClassLoader());
        }
    }
    public static void main(String[] args)throws Exception {
        System.setOut(System.err); // Includes third party System.out logging: never corrupt protocol.
        try(var input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8))) {
            String line;
            while((line=input.readLine())!=null) {
                JsonNode req;
                try {req=JSON.readTree(line);}catch(Exception e){emit(obj("jsonrpc","2.0","id",null,"error",obj("code",-32700,"message","Invalid JSON")));continue;}
                String id=req.path("id").asText();String method=req.path("method").asText();JsonNode p=req.path("params");
                if(method.equals("operation.cancel")) {
                    Operation running=operations.get(p.path("requestId").asText());
                    if(running!=null){running.cancelled=true;var target=running;CompletableFuture.runAsync(()->{try{if(target.connector!=null)target.connector.stop(target.context);}catch(Throwable ignored){}});}
                    emit(obj("jsonrpc","2.0","id",id,"result",obj("requested",running!=null)));continue;
                }
                var operation=new Operation();operations.put(id,operation);
                worker.submit(()->{
                    try {Object result=execute(method,p,operation,id);emit(obj("jsonrpc","2.0","id",id,"result",result));}
                    catch(Throwable e){boolean cancelled=operation.cancelled||e instanceof CancellationException;System.err.println("Operation failed: "+e.getClass().getName());emit(obj("jsonrpc","2.0","id",id,"error",obj("code",cancelled?-32800:-32000,"message",cancelled?"Cancelled; partial output may remain": e instanceof IllegalArgumentException?e.getMessage():"Connector operation failed ("+e.getClass().getSimpleName()+"); check datasource configuration and dependencies")));}
                    finally{operations.remove(id);}
                });
            }
        } finally {worker.shutdownNow();for(var plugin:plugins.values())try{plugin.close();}catch(Exception ignored){}System.exit(0);}
    }
}
