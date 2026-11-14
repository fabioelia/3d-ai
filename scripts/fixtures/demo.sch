<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<eagle version="9.6.2">
<drawing>
<settings><setting alwaysvectorfont="no"/></settings>
<grid distance="0.1" unitdist="inch" unit="inch" style="lines"/>
<layers>
<layer number="1" name="Top" color="4" fill="1" visible="yes" active="yes"/>
<layer number="20" name="Dimension" color="24" fill="1" visible="yes" active="yes"/>
<layer number="21" name="tPlace" color="7" fill="1" visible="yes" active="yes"/>
</layers>
<schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R">
<libraries>
<library name="demo">
<packages>
<package name="MOD_20X15">
<description>Sensor 20x15x3: module</description>
<pad name="1" x="0" y="0" drill="1" diameter="1.8" shape="square"/>
<pad name="2" x="2.54" y="0" drill="1" diameter="1.8"/>
<pad name="3" x="5.08" y="0" drill="1" diameter="1.8"/>
<wire x1="-2" y1="1.5" x2="18" y2="1.5" width="0.2" layer="21"/>
<wire x1="18" y1="1.5" x2="18" y2="-13.5" width="0.2" layer="21"/>
<wire x1="18" y1="-13.5" x2="-2" y2="-13.5" width="0.2" layer="21"/>
<wire x1="-2" y1="-13.5" x2="-2" y2="1.5" width="0.2" layer="21"/>
<text x="-2" y="2" size="1.27" layer="25">&gt;NAME</text>
</package>
<package name="R_AXIAL_0207">
<description>1/4 W axial resistor &amp; leads</description>
<pad name="1" x="0" y="0" drill="0.8" diameter="1.6"/>
<pad name="2" x="10.16" y="0" drill="0.8" diameter="1.6"/>
<rectangle x1="2.54" y1="-1.25" x2="7.62" y2="1.25" layer="51"/>
<wire x1="2.54" y1="-1" x2="7.62" y2="-1" width="0.2" layer="21"/>
</package>
<package name="CPOL_RAD_2.5_5">
<pad name="1" x="0" y="0" drill="0.8" diameter="1.5" shape="square"/>
<pad name="2" x="2.5" y="0" drill="0.8" diameter="1.5"/>
<circle x="1.25" y="0" radius="2.5" width="0.2" layer="21"/>
</package>
<package name="SOT23">
<smd name="1" x="-0.95" y="-1" dx="0.6" dy="1" layer="1"/>
<smd name="2" x="0.95" y="-1" dx="0.6" dy="1" layer="1"/>
<smd name="3" x="0" y="1" dx="0.6" dy="1" layer="1"/>
<wire x1="-1.45" y1="-0.65" x2="1.45" y2="-0.65" width="0.1" layer="51"/>
<wire x1="1.45" y1="-0.65" x2="1.45" y2="0.65" width="0.1" layer="51"/>
<wire x1="1.45" y1="0.65" x2="-1.45" y2="0.65" width="0.1" layer="51"/>
<wire x1="-1.45" y1="0.65" x2="-1.45" y2="-0.65" width="0.1" layer="51"/>
</package>
</packages>
<symbols>
<symbol name="S"><pin name="VCC" x="-5" y="2"/></symbol>
</symbols>
<devicesets>
<deviceset name="SENSOR" prefix="U">
<gates><gate name="G$1" symbol="S" x="0" y="0"/></gates>
<devices><device name="" package="MOD_20X15"><connects>
<connect gate="G$1" pin="VCC" pad="1"/><connect gate="G$1" pin="GND" pad="2"/><connect gate="G$1" pin="OUT" pad="3"/>
</connects><technologies><technology name=""/></technologies></device></devices>
</deviceset>
<deviceset name="R" prefix="R">
<gates><gate name="G$1" symbol="R" x="0" y="0"/></gates>
<devices><device name="0207" package="R_AXIAL_0207"><connects>
<connect gate="G$1" pin="1" pad="1"/><connect gate="G$1" pin="2" pad="2"/>
</connects></device></devices>
</deviceset>
<deviceset name="CPOL" prefix="C">
<gates><gate name="G$1" symbol="C" x="0" y="0"/></gates>
<devices><device name="" package="CPOL_RAD_2.5_5"><connects>
<connect gate="G$1" pin="+" pad="1"/><connect gate="G$1" pin="-" pad="2"/>
</connects></device></devices>
</deviceset>
<deviceset name="NMOS" prefix="Q">
<gates><gate name="G$1" symbol="Q" x="0" y="0"/></gates>
<devices><device name="" package="SOT23"><connects>
<connect gate="G$1" pin="G" pad="1"/><connect gate="G$1" pin="S" pad="2"/><connect gate="G$1" pin="D" pad="3"/>
</connects></device></devices>
</deviceset>
<deviceset name="GND">
<gates><gate name="1" symbol="GND" x="0" y="0"/></gates>
<devices><device name=""/></devices>
</deviceset>
</devicesets>
</library>
</libraries>
<attributes/>
<variantdefs/>
<classes><class number="0" name="default" width="0" drill="0"/></classes>
<parts>
<part name="U1" library="demo" deviceset="SENSOR" device="" value="Sensor"/>
<part name="R1" library="demo" deviceset="R" device="0207" value="10k"/>
<part name="C1" library="demo" deviceset="CPOL" device="" value="22uF"/>
<part name="Q1" library="demo" deviceset="NMOS" device="" value="2N7002"/>
<part name="GND1" library="demo" deviceset="GND" device=""/>
</parts>
<sheets>
<sheet>
<plain/>
<instances/>
<busses/>
<nets>
<net name="VCC" class="0">
<segment><pinref part="U1" gate="G$1" pin="VCC"/><wire x1="0" y1="0" x2="5" y2="0" width="0.1524" layer="91"/><pinref part="R1" gate="G$1" pin="1"/><pinref part="C1" gate="G$1" pin="+"/></segment>
</net>
<net name="GND" class="0">
<segment><pinref part="U1" gate="G$1" pin="GND"/><pinref part="C1" gate="G$1" pin="-"/><pinref part="Q1" gate="G$1" pin="S"/><pinref part="GND1" gate="1" pin="GND"/></segment>
</net>
<net name="SIG" class="0">
<segment><pinref part="U1" gate="G$1" pin="OUT"/><pinref part="Q1" gate="G$1" pin="G"/></segment>
<segment><pinref part="R1" gate="G$1" pin="2"/><pinref part="Q1" gate="G$1" pin="D"/></segment>
</net>
</nets>
</sheet>
</sheets>
</schematic>
</drawing>
</eagle>
