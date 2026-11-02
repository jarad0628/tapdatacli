package io.tapdata.mini.file;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.tapdata.entity.codec.TapCodecsRegistry;
import io.tapdata.entity.event.TapEvent;
import io.tapdata.entity.event.dml.TapInsertRecordEvent;
import io.tapdata.entity.schema.TapField;
import io.tapdata.entity.schema.TapTable;
import io.tapdata.pdk.apis.TapConnector;
import io.tapdata.pdk.apis.annotations.TapConnectorClass;
import io.tapdata.pdk.apis.context.TapConnectionContext;
import io.tapdata.pdk.apis.entity.ConnectionOptions;
import io.tapdata.pdk.apis.entity.TestItem;
import io.tapdata.pdk.apis.functions.ConnectorFunctions;
import java.nio.file.*;
import java.util.*;
import java.util.function.Consumer;

/** A real PDK file source; not a simulated engine or database connector. */
@TapConnectorClass("local-json.json")
public class LocalJsonConnector implements TapConnector {
    private volatile boolean stopped;
    private Map<String,List<Map<String,Object>>> read(TapConnectionContext c) throws Exception {
        return new ObjectMapper().readValue(Path.of(c.getConnectionConfig().getString("path")).toFile(), new TypeReference<>() {});
    }
    public void init(TapConnectionContext c) { stopped=false; }
    public void stop(TapConnectionContext c) { stopped=true; }
    public ConnectionOptions connectionTest(TapConnectionContext c, Consumer<TestItem> out) {
        try { read(c); out.accept(new TestItem("Read JSON file",1,"Readable JSON table map")); }
        catch(Exception e) { out.accept(new TestItem("Read JSON file",10,"File missing or invalid JSON")); }
        return new ConnectionOptions();
    }
    public int tableCount(TapConnectionContext c) throws Throwable { return read(c).size(); }
    public void discoverSchema(TapConnectionContext c,List<String> tables,int size,Consumer<List<TapTable>> out) throws Throwable {
        var result=new ArrayList<TapTable>();
        read(c).forEach((name,rows)->{
            if(tables!=null && !tables.contains(name)) return;
            var table=new TapTable(name); var fields=new LinkedHashMap<String,TapField>();
            for(var row:rows) row.forEach((k,v)->fields.putIfAbsent(k,new TapField(k,v instanceof Number?"number":v instanceof Boolean?"boolean":"string")));
            table.setNameFieldMap(fields); result.add(table);
        });
        out.accept(result);
    }
    public void registerCapabilities(ConnectorFunctions f,TapCodecsRegistry codecs) {
        f.supportBatchRead((c,t,offset,batchSize,out)->{
            var rows=read(c).get(t.getId()); if(rows==null) throw new IllegalArgumentException("Unknown table");
            var batch=new ArrayList<TapEvent>(); int n=0;
            for(var row:rows) {
                if(stopped) break;
                batch.add(new TapInsertRecordEvent().after(row)); n++;
                if(batch.size()>=batchSize) { out.accept(batch,n); batch=new ArrayList<>(); }
            }
            if(!batch.isEmpty() && !stopped) out.accept(batch,n);
        });
    }
}
